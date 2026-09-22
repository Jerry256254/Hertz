import { and, desc, eq, isNull } from "drizzle-orm";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agentMemoryAtoms, agentMemoryScenarios, agents, messages } from "../db/schema.js";
import type { HertzPaths } from "../paths.js";
import { loadAgentMemoryConfig } from "./config.js";
import {
  buildAtomExtractionPrompt,
  buildPersonaPrompt,
  buildScenarioClusteringPrompt,
  parseAtomsResponse,
  parsePersonaResponse,
  parseScenariosResponse,
} from "./extraction.js";
import { isNearDuplicate, keywordsFor } from "./tokenize.js";
import { backfillLegacyMemory, loadMemoryState, loadPersona, saveMemoryState, writePersona, writeScenarioMirror } from "./recall.js";
import { syncAtomVectors } from "./vector-store.js";

export interface MemoryPipelineDeps {
  db: Database;
  paths: HertzPaths;
  providers: {
    getAdapter(providerConfigId: string): Promise<{
      chat(req: { model: string; system: string; messages: Array<{ role: "user"; content: ContentBlock[] }>; maxTokens?: number; temperature?: number }): Promise<{
        content: ContentBlock[];
      }>;
    }>;
  };
}

const running = new Set<string>();

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Short-term trigger after every agent run: distills the session's new turns
 * (L0) into atoms (L1), re-clusters scenarios (L2), and refreshes the persona
 * (L3) — each stage on its own cadence. Fire-and-forget; at most one run per
 * agent; every failure is silent (memory must never break work).
 */
export async function runMemoryPipeline(deps: MemoryPipelineDeps, agentId: string, sessionId: string): Promise<boolean> {
  if (running.has(agentId)) return false;
  running.add(agentId);
  try {
    return await runPipelineInner(deps, agentId, sessionId);
  } catch (err) {
    // Memory must never break work — but it must never fail silently either:
    // every swallowed error here used to look exactly like "memory doesn't work".
    console.warn(`[hertz] memory: pipeline run failed for agent ${agentId}:`, err instanceof Error ? err.message : err);
    return false;
  } finally {
    running.delete(agentId);
  }
}

async function runPipelineInner(deps: MemoryPipelineDeps, agentId: string, sessionId: string): Promise<boolean> {
  const config = loadAgentMemoryConfig();
  const agentRows = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  const agent = agentRows[0];
  if (!agent) return false;

  await backfillLegacyMemory(deps.db, deps.paths, agent.projectId, agentId).catch((err) => {
    console.warn(`[hertz] memory: legacy backfill failed for agent ${agentId}:`, err instanceof Error ? err.message : err);
    return 0;
  });
  const state = await loadMemoryState(deps.paths, agent.projectId, agentId);

  const history = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt))
    .limit(120);
  const chronological = history.reverse();
  if (chronological.length === 0) return false;

  const watermark = state.extractedThrough[sessionId];
  const watermarkIdx = watermark ? chronological.findIndex((m) => m.id === watermark) : -1;
  const fresh = watermarkIdx === -1 ? chronological : chronological.slice(watermarkIdx + 1);
  const lastId = chronological[chronological.length - 1]!.id;

  // Fresh "turns" = user messages carrying real text (not tool-result plumbing).
  const freshTurns = fresh.filter(
    (m) => m.role === "user" && m.content.includes('"type":"text"') && !m.content.includes('"type":"tool_result"'),
  );
  const seenBefore = watermark !== undefined;
  const requiredTurns = seenBefore ? config.extractEveryNTurns : Math.min(2, config.extractEveryNTurns);

  let totalAtoms = await countAtoms(deps.db, agentId);
  let didWork = false;

  // ── L0 → L1 ──────────────────────────────────────────────────────────
  if (freshTurns.length >= requiredTurns) {
    const transcript = buildTranscript(fresh);
    // The watermark advances only past turns that were actually distilled.
    // A failed LLM call must NOT advance it — otherwise those turns are
    // silently lost forever (the failure is logged; the next run retries).
    // An unparseable-but-successful reply ("nothing worth keeping") still
    // advances: it was attempted, and must not poison every future run.
    let extractionOk = false;
    if (!transcript.trim()) {
      extractionOk = true;
    } else {
      try {
        const existing = await deps.db
          .select({ text: agentMemoryAtoms.text })
          .from(agentMemoryAtoms)
          .where(eq(agentMemoryAtoms.agentId, agentId))
          .orderBy(desc(agentMemoryAtoms.createdAt))
          .limit(40);
        const newAtoms = await distillAtoms(deps, agent, transcript, existing.map((e) => e.text), config.maxAtomsPerPass);
        const stored = await storeAtoms(deps, agentId, sessionId, newAtoms);
        if (stored > 0) {
          totalAtoms += stored;
          didWork = true;
          console.log(`[hertz] memory: stored ${stored} atom(s) for agent ${agentId} (session ${sessionId})`);
        }
        extractionOk = true;
      } catch (err) {
        console.warn(
          `[hertz] memory: extraction failed for agent ${agentId} session ${sessionId} — turns kept for the next run:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (extractionOk) {
      state.extractedThrough[sessionId] = lastId;
      await saveMemoryState(deps.paths, agent.projectId, agentId, state).catch(() => {});
    }
  }

  // ── L1 → L2 ──────────────────────────────────────────────────────────
  const unclustered = await deps.db
    .select()
    .from(agentMemoryAtoms)
    .where(and(eq(agentMemoryAtoms.agentId, agentId), isNull(agentMemoryAtoms.scenarioId)))
    .limit(150);
  if (unclustered.length >= config.clusterEveryNAtoms && unclustered.length > 0) {
    const clustered = await clusterScenarios(deps, agentId, agent, unclustered);
    if (clustered) {
      state.atomsAtLastCluster = totalAtoms;
      await saveMemoryState(deps.paths, agent.projectId, agentId, state).catch(() => {});
      didWork = true;
    }
  }

  // ── L2 → L3 ──────────────────────────────────────────────────────────
  const personaDue =
    totalAtoms - state.atomsAtLastPersona >= config.personaEveryNAtoms &&
    (!state.lastPersonaAt || Date.now() - new Date(state.lastPersonaAt).getTime() > config.minPersonaIntervalMs);
  if (personaDue && totalAtoms > 0) {
    const refreshed = await refreshPersona(deps, agentId, agent);
    if (refreshed) {
      state.atomsAtLastPersona = totalAtoms;
      state.lastPersonaAt = new Date().toISOString();
      await saveMemoryState(deps.paths, agent.projectId, agentId, state).catch(() => {});
      didWork = true;
    }
  }

  // Vector sidecar: embed whatever L1 atoms lack vectors (bounded per run,
  // silent no-op without an embedder or sqlite-vec). Covers remember() writes
  // and backfills, not just this run's distilled atoms.
  await syncAtomVectors(deps.db, deps.paths, agentId).catch((err) => {
    console.warn(`[hertz] memory: vector sync failed for agent ${agentId}:`, err instanceof Error ? err.message : err);
    return 0;
  });

  return didWork;
}

async function countAtoms(db: Database, agentId: string): Promise<number> {
  const rows = await db.select({ id: agentMemoryAtoms.id }).from(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, agentId)).limit(5000);
  return rows.length;
}

/** Compact transcript for distillation: user/assistant text + tool names (not outputs). */
function buildTranscript(rows: Array<typeof messages.$inferSelect>, maxChars = 6000): string {
  const lines: string[] = [];
  for (const row of rows) {
    let blocks: ContentBlock[] = [];
    try {
      blocks = JSON.parse(row.content) as ContentBlock[];
    } catch {
      continue;
    }
    const who = row.role === "assistant" ? "Agent" : row.role === "system" ? "System" : row.senderAgentId ? "Colleague" : "User";
    const text = textOf(blocks).trim();
    if (text) lines.push(`${who}: ${text.slice(0, 1200)}`);
    for (const block of blocks) {
      if (block.type === "tool_use") lines.push(`[called ${block.name}]`);
    }
  }
  const joined = lines.join("\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

async function chatJson(deps: MemoryPipelineDeps, agent: { providerConfigId: string; model: string }, prompt: string, maxTokens: number): Promise<string> {
  const adapter = await deps.providers.getAdapter(agent.providerConfigId);
  const res = await adapter.chat({
    model: agent.model,
    system: "You output only valid JSON. No commentary.",
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    maxTokens,
    temperature: 0.2,
  });
  return textOf(res.content);
}

/**
 * Throws when the provider call itself fails (the caller keeps the watermark
 * so the turns are retried); returns [] when the model simply found nothing
 * worth keeping or its reply didn't parse (that outcome is final — retrying
 * a poison transcript on every run would be worse).
 */
async function distillAtoms(
  deps: MemoryPipelineDeps,
  agent: { providerConfigId: string; model: string },
  transcript: string,
  existingTexts: string[],
  maxAtoms: number,
): Promise<Array<{ text: string; importance: number }>> {
  const raw = await chatJson(deps, agent, buildAtomExtractionPrompt(transcript, maxAtoms, existingTexts.slice(0, 40)), 1200);
  return parseAtomsResponse(raw, maxAtoms);
}

async function storeAtoms(
  deps: MemoryPipelineDeps,
  agentId: string,
  sessionId: string,
  atoms: Array<{ text: string; importance: number }>,
): Promise<number> {
  if (atoms.length === 0) return 0;
  const existing = await deps.db
    .select({ keywords: agentMemoryAtoms.keywords })
    .from(agentMemoryAtoms)
    .where(eq(agentMemoryAtoms.agentId, agentId))
    .orderBy(desc(agentMemoryAtoms.createdAt))
    .limit(200);
  let stored = 0;
  for (const atom of atoms) {
    const duplicate = existing.some((e) => isNearDuplicate(atom.text, e.keywords));
    if (duplicate) continue;
    const keywords = keywordsFor(atom.text);
    await deps.db.insert(agentMemoryAtoms).values({
      id: newId(),
      agentId,
      text: atom.text,
      importance: atom.importance,
      keywords,
      sourceSessionId: sessionId,
      createdAt: new Date(),
    });
    existing.unshift({ keywords });
    stored++;
  }
  return stored;
}

async function clusterScenarios(
  deps: MemoryPipelineDeps,
  agentId: string,
  agent: { providerConfigId: string; model: string; projectId: string },
  unclustered: Array<typeof agentMemoryAtoms.$inferSelect>,
): Promise<boolean> {
  const existingScenarios = await deps.db.select().from(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, agentId)).limit(60);
  let raw: string;
  try {
    raw = await chatJson(
      deps,
      agent,
      buildScenarioClusteringPrompt(
        unclustered.map((a, i) => ({ index: i + 1, text: a.text })),
        existingScenarios.map((s) => ({ slug: s.slug, title: s.title })),
      ),
      1500,
    );
  } catch (err) {
    console.warn(`[hertz] memory: clustering LLM call failed for agent ${agentId}:`, err instanceof Error ? err.message : err);
    return false;
  }
  const scenarios = parseScenariosResponse(raw, unclustered.length);
  if (scenarios.length === 0) return false;

  for (const scenario of scenarios) {
    const memberAtoms = scenario.atomIndexes.map((i) => unclustered[i - 1]!).filter(Boolean);
    if (memberAtoms.length === 0) continue;
    const now = new Date();
    const current = existingScenarios.find((s) => s.slug === scenario.slug);
    let scenarioId = current?.id;
    let atomIds: string[] = memberAtoms.map((a) => a.id);
    if (current) {
      try {
        const prev = JSON.parse(current.atomIdsJson) as string[];
        atomIds = [...new Set([...(Array.isArray(prev) ? prev : []), ...atomIds])];
      } catch {
        /* keep fresh list */
      }
      await deps.db
        .update(agentMemoryScenarios)
        .set({ title: scenario.title, summary: scenario.summary, atomIdsJson: JSON.stringify(atomIds), updatedAt: now })
        .where(eq(agentMemoryScenarios.id, current.id));
    } else {
      scenarioId = newId();
      await deps.db.insert(agentMemoryScenarios).values({
        id: scenarioId,
        agentId,
        slug: scenario.slug,
        title: scenario.title,
        summary: scenario.summary,
        atomIdsJson: JSON.stringify(atomIds),
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const atom of memberAtoms) {
      await deps.db.update(agentMemoryAtoms).set({ scenarioId }).where(eq(agentMemoryAtoms.id, atom.id));
    }
    const row = (await deps.db.select().from(agentMemoryScenarios).where(eq(agentMemoryScenarios.id, scenarioId!)).limit(1))[0];
    if (row) {
      const texts = await deps.db
        .select({ text: agentMemoryAtoms.text })
        .from(agentMemoryAtoms)
        .where(and(eq(agentMemoryAtoms.agentId, agentId), eq(agentMemoryAtoms.scenarioId, scenarioId!)))
        .limit(60);
      await writeScenarioMirror(deps.paths, agent.projectId, agentId, row, texts.map((t) => t.text)).catch(() => {});
    }
  }
  return true;
}

async function refreshPersona(
  deps: MemoryPipelineDeps,
  agentId: string,
  agent: { providerConfigId: string; model: string; projectId: string },
): Promise<boolean> {
  const [scenarios, atoms] = await Promise.all([
    deps.db.select().from(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, agentId)).orderBy(desc(agentMemoryScenarios.updatedAt)).limit(20),
    deps.db.select().from(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, agentId)).orderBy(desc(agentMemoryAtoms.importance)).limit(30),
  ]);
  if (scenarios.length === 0 && atoms.length === 0) return false;
  const previous = await loadPersona(deps.paths, agent.projectId, agentId).catch(() => "");
  let raw: string;
  try {
    raw = await chatJson(
      deps,
      agent,
      buildPersonaPrompt(
        scenarios.map((s) => ({ title: s.title, summary: s.summary })),
        atoms.map((a) => a.text),
        previous,
      ),
      800,
    );
  } catch (err) {
    console.warn(`[hertz] memory: persona refresh LLM call failed for agent ${agentId}:`, err instanceof Error ? err.message : err);
    return false;
  }
  const persona = parsePersonaResponse(raw);
  if (!persona) return false;
  await writePersona(deps.paths, agent.projectId, agentId, persona).catch(() => {});
  return true;
}
