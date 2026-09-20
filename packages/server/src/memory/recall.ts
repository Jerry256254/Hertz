import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agentMemory, agentMemoryAtoms, agentMemoryScenarios, agents } from "../db/schema.js";
import type { HertzPaths } from "../paths.js";
import { agentMemoryDir, agentMemoryStatePath, agentPersonaPath, agentScenariosDir, legacySoulPath } from "../paths.js";
import { loadAgentMemoryConfig } from "./config.js";
import { fuseRankings, keywordsFor, rankByRelevance, scoreByRelevance } from "./tokenize.js";
import { loadCanvas } from "./short-term.js";
import { searchAtomVectors } from "./vector-store.js";

export type MemoryAtom = typeof agentMemoryAtoms.$inferSelect;
export type MemoryScenario = typeof agentMemoryScenarios.$inferSelect;

export interface MemoryState {
  /** sessionId → last L0 message id distilled into L1. */
  extractedThrough: Record<string, string>;
  /** Atom count at the last L2 clustering / L3 persona refresh. */
  atomsAtLastCluster: number;
  atomsAtLastPersona: number;
  lastPersonaAt: string | null;
  legacyBackfilled: boolean;
}

export function emptyMemoryState(): MemoryState {
  return { extractedThrough: {}, atomsAtLastCluster: 0, atomsAtLastPersona: 0, lastPersonaAt: null, legacyBackfilled: false };
}

/**
 * The agent's home project — his memory/skills live under the employee home
 * there (agents.projectId, not the current session's project, so one agent
 * has exactly one home across every chat). Cached for the process lifetime;
 * projectId is never reassigned.
 */
const homeProjectCache = new Map<string, string>();

export async function resolveAgentProjectId(db: Database, agentId: string): Promise<string | undefined> {
  const hit = homeProjectCache.get(agentId);
  if (hit) return hit;
  try {
    const rows = await db.select({ projectId: agents.projectId }).from(agents).where(eq(agents.id, agentId)).limit(1);
    const pid = rows[0]?.projectId;
    if (pid) homeProjectCache.set(agentId, pid);
    return pid ?? undefined;
  } catch {
    return undefined;
  }
}

export async function loadMemoryState(paths: HertzPaths, projectId: string, agentId: string): Promise<MemoryState> {
  try {
    const raw = await fs.readFile(agentMemoryStatePath(paths, projectId, agentId), "utf8");
    return { ...emptyMemoryState(), ...(JSON.parse(raw) as Partial<MemoryState>) };
  } catch {
    return emptyMemoryState();
  }
}

export async function saveMemoryState(paths: HertzPaths, projectId: string, agentId: string, state: MemoryState): Promise<void> {
  await fs.mkdir(agentMemoryDir(paths, projectId, agentId), { recursive: true });
  await fs.writeFile(agentMemoryStatePath(paths, projectId, agentId), JSON.stringify(state, null, 2), "utf8");
}

/**
 * One-time migration: legacy agent_memory rows (fact/episode/preference)
 * become L1 atoms, preserving importance + keywords. Idempotent via the state
 * flag; legacy rows are left untouched for rollback.
 */
export async function backfillLegacyMemory(db: Database, paths: HertzPaths, projectId: string, agentId: string): Promise<number> {
  const state = await loadMemoryState(paths, projectId, agentId);
  if (state.legacyBackfilled) return 0;
  const legacy = await db.select().from(agentMemory).where(eq(agentMemory.agentId, agentId)).orderBy(desc(agentMemory.createdAt)).limit(500);
  let imported = 0;
  for (const row of legacy.reverse()) {
    const text = row.note?.trim();
    if (!text) continue;
    await db.insert(agentMemoryAtoms).values({
      id: newId(),
      agentId,
      text: text.slice(0, 500),
      importance: Math.min(5, Math.max(1, row.importance ?? 2)),
      keywords: row.keywords ?? keywordsFor(text),
      createdAt: row.createdAt,
    });
    imported++;
  }
  state.legacyBackfilled = true;
  await saveMemoryState(paths, projectId, agentId, state);
  return imported;
}

/** L3 persona text for prompt injection (migrates legacy soul.md on first read). */
export async function loadPersona(paths: HertzPaths, projectId: string, agentId: string): Promise<string> {
  const personaPath = agentPersonaPath(paths, projectId, agentId);
  try {
    const raw = await fs.readFile(personaPath, "utf8");
    return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  } catch {
    /* fall through to soul migration */
  }
  // Legacy soul: the adopted copy in the home first, then the pre-pivot path
  // (for installs whose home migration hasn't run yet).
  for (const soulPath of [
    path.join(agentMemoryDir(paths, projectId, agentId), "soul.md"),
    legacySoulPath(paths, agentId),
  ]) {
    try {
      const soul = await fs.readFile(soulPath, "utf8");
      const body = soul.replace(/^# Soul[\s\S]*?_\n/, "").trim();
      if (body) {
        await writePersona(paths, projectId, agentId, body);
        return body;
      }
    } catch {
      /* try the next location */
    }
  }
  return "";
}

export async function writePersona(paths: HertzPaths, projectId: string, agentId: string, body: string): Promise<void> {
  await fs.mkdir(agentMemoryDir(paths, projectId, agentId), { recursive: true });
  const frontmatter = `---\nupdated: ${new Date().toISOString()}\nlayer: L3-persona\n---\n\n`;
  await fs.writeFile(agentPersonaPath(paths, projectId, agentId), `${frontmatter}${body.trim()}\n`, "utf8");
}

/** White-box mirror of one L2 scenario row → scenarios/<slug>.md. */
export async function writeScenarioMirror(
  paths: HertzPaths,
  projectId: string,
  agentId: string,
  scenario: MemoryScenario,
  atomTexts: string[],
): Promise<void> {
  const dir = agentScenariosDir(paths, projectId, agentId);
  await fs.mkdir(dir, { recursive: true });
  const body = [
    `---`,
    `slug: ${scenario.slug}`,
    `title: ${scenario.title}`,
    `updated: ${scenario.updatedAt.toISOString()}`,
    `layer: L2-scenario`,
    `---`,
    ``,
    `# ${scenario.title}`,
    ``,
    scenario.summary,
    ``,
    ...(atomTexts.length > 0 ? [`## Atoms`, ``, ...atomTexts.map((t) => `- ${t}`), ``] : []),
  ].join("\n");
  await fs.writeFile(path.join(dir, `${scenario.slug}.md`), body, "utf8");
}

export interface LayeredRecall {
  persona: string;
  scenarios: MemoryScenario[];
  atoms: MemoryAtom[];
  canvas: string;
}

/**
 * Hybrid L1 ranking: keyword scoring fused (RRF) with the sqlite-vec cosine
 * ranking when vectors are available. Without paths, an embedder, or the
 * native extension this degrades to pure keyword ranking — same order as
 * rankByRelevance. Returns oldest-first for stable prompt narratives.
 */
async function rankAtomsHybrid(
  db: Database,
  paths: HertzPaths | undefined,
  agentId: string,
  atomRows: MemoryAtom[],
  query: string,
  limit: number,
): Promise<MemoryAtom[]> {
  const keywordRanking = scoreByRelevance(atomRows, query).map((s) => s.item.id);
  const rankings = [keywordRanking];
  if (paths && query.trim()) {
    const vectorRanking = await searchAtomVectors(db, paths, agentId, query, limit).catch(() => [] as string[]);
    if (vectorRanking.length > 0) rankings.push(vectorRanking);
  }
  const byId = new Map(atomRows.map((a) => [a.id, a]));
  return fuseRankings(
    atomRows.map((a) => a.id),
    rankings,
    limit,
  )
    .map((id) => byId.get(id))
    .filter((a): a is MemoryAtom => a !== undefined)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Progressive disclosure for prompt injection: persona (L3) always, then the
 * top-ranked scenarios (L2) and atoms (L1) for the current conversation, then
 * the live session canvas (short-term symbols). Refreshes lastUsedAt for what
 * was injected so the UI can show what's actually being used.
 */
export async function recallForPrompt(
  db: Database,
  paths: HertzPaths | undefined,
  agentId: string,
  contextText: string,
  sessionId?: string,
  projectId?: string,
): Promise<LayeredRecall> {
  const config = loadAgentMemoryConfig();
  const [atomRows, scenarioRows] = await Promise.all([
    db.select().from(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, agentId)).orderBy(desc(agentMemoryAtoms.createdAt)).limit(400),
    db.select().from(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, agentId)).orderBy(desc(agentMemoryScenarios.updatedAt)).limit(60),
  ]);

  const atoms = await rankAtomsHybrid(db, paths, agentId, [...atomRows].reverse(), contextText, config.promptMaxAtoms);
  const scenarios = rankByRelevance(
    scenarioRows.map((s) => ({ ...s, importance: 3, keywords: keywordsFor(`${s.title} ${s.summary}`), createdAt: s.updatedAt })),
    contextText,
    config.promptMaxScenarios,
  );

  let persona = "";
  let canvas = "";
  if (paths) {
    const pid = projectId ?? (await resolveAgentProjectId(db, agentId).catch(() => undefined));
    if (pid) {
      const [p, c] = await Promise.all([
        loadPersona(paths, pid, agentId).catch(() => ""),
        sessionId ? loadCanvas(paths, pid, agentId, sessionId).catch(() => "") : Promise.resolve(""),
      ]);
      persona = p.slice(0, config.promptMaxPersonaChars);
      canvas = c;
    }
  }

  // Touch what we injected (fire-and-forget semantics via await-all; cheap single round-trip each).
  const touchedAtomIds = atoms.map((a) => a.id);
  if (touchedAtomIds.length > 0) {
    await db.update(agentMemoryAtoms).set({ lastUsedAt: new Date() }).where(inArray(agentMemoryAtoms.id, touchedAtomIds)).catch(() => {});
  }
  return { persona, scenarios, atoms, canvas };
}

/** Renders a LayeredRecall as the system-prompt memory block. */
export function renderMemoryBlock(recall: LayeredRecall): string {
  const parts: string[] = [];
  if (recall.persona) {
    parts.push(`### Who you are (L3 persona — self-maintained)\n${recall.persona}\nKeep this current — it is your living self-image.`);
  }
  if (recall.scenarios.length > 0) {
    const block = recall.scenarios.map((s) => `- **${s.title}**: ${s.summary}`).join("\n");
    parts.push(`### What you know (L2 scenarios)\n${block}`);
  }
  if (recall.atoms.length > 0) {
    const block = recall.atoms.map((a) => `- ${a.text}`).join("\n");
    parts.push(`### Details (L1 facts)\nThis carries across every chat, project, and meeting you're part of — the user can see it too. Add your own with remember for anything durable, prune with forget, and use recall_memory to dig deeper.\n${block}`);
  }
  if (recall.canvas.trim()) {
    parts.push(`### Live task canvas (this session's short-term symbols)\n\`\`\`mermaid\n${recall.canvas.trim()}\n\`\`\`\nNodes marked ref: <id> carry full tool output — call read_memory_ref to retrieve it.`);
  }
  if (parts.length === 0) return "";
  return `## Your memory (layered, yours alone)\n${parts.join("\n\n")}`;
}

export interface MemorySearchHit {
  layer: "L2-scenario" | "L1-atom";
  id: string;
  text: string;
  importance: number;
  /** Drill-down path, e.g. "persona › friday-reports › atom 1a2b". */
  trace: string;
  scenarioSlug?: string;
  sourceSessionId?: string | null;
}

/**
 * recall_memory tool backend: hybrid search across L2 + L1 with full
 * traceability (scenario → atom → source conversation). L1 atoms fuse keyword
 * scoring with sqlite-vec cosine similarity when `paths` unlocks the vector
 * sidecar; without it (or without an embedder) search stays keyword-only.
 */
export async function searchMemory(db: Database, agentId: string, query: string, paths?: HertzPaths): Promise<MemorySearchHit[]> {
  const config = loadAgentMemoryConfig();
  const [atomRows, scenarioRows] = await Promise.all([
    db.select().from(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, agentId)).orderBy(desc(agentMemoryAtoms.createdAt)).limit(400),
    db.select().from(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, agentId)).limit(60),
  ]);
  const byId = new Map(scenarioRows.map((s) => [s.id, s]));
  const rankedAtoms = await rankAtomsHybrid(db, paths, agentId, [...atomRows].reverse(), query, config.recallMaxResults);
  const rankedScenarios = rankByRelevance(
    scenarioRows.map((s) => ({ ...s, importance: 3, keywords: keywordsFor(`${s.title} ${s.summary}`), createdAt: s.updatedAt })),
    query,
    Math.min(3, config.recallMaxResults),
  );

  const hits: MemorySearchHit[] = [];
  for (const scenario of rankedScenarios) {
    hits.push({
      layer: "L2-scenario",
      id: scenario.id,
      text: `${scenario.title}: ${scenario.summary}`.slice(0, config.recallMaxCharsPerItem),
      importance: 3,
      trace: `persona › ${scenario.slug}`,
      scenarioSlug: scenario.slug,
    });
  }
  for (const atom of rankedAtoms) {
    const scenario = atom.scenarioId ? byId.get(atom.scenarioId) : undefined;
    hits.push({
      layer: "L1-atom",
      id: atom.id,
      text: atom.text.slice(0, config.recallMaxCharsPerItem),
      importance: atom.importance,
      trace: scenario ? `persona › ${scenario.slug} › atom ${atom.id.slice(0, 8)}` : `persona › (unclustered) › atom ${atom.id.slice(0, 8)}`,
      scenarioSlug: scenario?.slug,
      sourceSessionId: atom.sourceSessionId,
    });
  }
  const touched = rankedAtoms.map((a) => a.id);
  if (touched.length > 0) {
    await db.update(agentMemoryAtoms).set({ lastUsedAt: new Date() }).where(inArray(agentMemoryAtoms.id, touched)).catch(() => {});
  }
  return hits.slice(0, config.recallMaxResults + 3);
}

/** forget tool backend: deletes an L1 atom (or a legacy note) by id. */
export async function forgetById(db: Database, agentId: string, noteId: string): Promise<boolean> {
  const atomRows = await db
    .select({ id: agentMemoryAtoms.id })
    .from(agentMemoryAtoms)
    .where(and(eq(agentMemoryAtoms.id, noteId), eq(agentMemoryAtoms.agentId, agentId)))
    .limit(1);
  if (atomRows.length > 0) {
    await db.delete(agentMemoryAtoms).where(eq(agentMemoryAtoms.id, noteId));
    return true;
  }
  const legacyRows = await db
    .select({ id: agentMemory.id })
    .from(agentMemory)
    .where(and(eq(agentMemory.id, noteId), eq(agentMemory.agentId, agentId)))
    .limit(1);
  if (legacyRows.length > 0) {
    await db.delete(agentMemory).where(eq(agentMemory.id, noteId));
    return true;
  }
  return false;
}
