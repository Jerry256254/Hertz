import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agentMemory, agents } from "../db/schema.js";
import type { HertzPaths } from "../paths.js";
import { agentSkillsDir } from "../paths.js";

export interface ConsolidationDeps {
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

const EPISODE_THRESHOLD = 6;
const consolidating = new Set<string>();

/**
 * Smart memory (Hermes-style self-management): instead of accumulating every
 * "was told X" episode forever, the agent periodically consolidates its own
 * memory with its own model — deduplicating, extracting durable facts with
 * importance, discarding noise — and rewrites its soul.md (identity, user
 * preferences, lessons learned). The result is a memory that stays small and
 * sharp instead of growing into a transcript dump.
 *
 * Runs fire-and-forget after agent runs; at most one consolidation per agent
 * at a time; triggers when enough episodes piled up (or every 8th run).
 */
export async function maybeConsolidateMemory(deps: ConsolidationDeps, agentId: string): Promise<boolean> {
  if (consolidating.has(agentId)) return false;

  const agentRows = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  const agent = agentRows[0];
  if (!agent) return false;

  const episodes = await deps.db
    .select()
    .from(agentMemory)
    .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.kind, "episode")))
    .orderBy(desc(agentMemory.createdAt))
    .limit(30);

  const facts = await deps.db
    .select()
    .from(agentMemory)
    .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.kind, "fact")))
    .orderBy(desc(agentMemory.createdAt))
    .limit(60);

  const runCount = episodes.length + facts.length;
  if (episodes.length < EPISODE_THRESHOLD && runCount % 8 !== 0) return false;
  if (episodes.length === 0 && facts.length === 0) return false;

  consolidating.add(agentId);
  try {
    const adapter = await deps.providers.getAdapter(agent.providerConfigId);

    const prompt = [
      "You are a memory curator for an AI agent. Consolidate its memory.",
      "",
      "EXISTING FACTS (durable knowledge):",
      facts.length > 0 ? facts.map((f) => `- [${f.importance}] ${f.note}`).join("\n") : "(none)",
      "",
      "RECENT EPISODES (raw what-happened notes):",
      episodes.length > 0 ? episodes.map((e) => `- ${e.note}`).join("\n") : "(none)",
      "",
      "Produce STRICT JSON only, no markdown fences:",
      `{"facts":[{"note":"...","importance":1-5}],"soul":"2-4 sentence living profile of this agent: who it serves, what it works on, how it likes to work, lessons learned"}`,
      "",
      "Rules: merge duplicates; promote durable knowledge from episodes into facts; drop small-talk and stale noise; keep facts under 25 and sharp; importance 1-5 (5 = always-relevant). The soul text is written in first person, present tense.",
    ].join("\n");

    const res = await adapter.chat({
      model: agent.model,
      system: "You output only valid JSON. No commentary.",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      maxTokens: 1500,
      temperature: 0.2,
    });

    const raw = res.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const jsonMatch = /\{[\s\S]*\}/.exec(raw);
    if (!jsonMatch) return false;

    const parsed = JSON.parse(jsonMatch[0]) as {
      facts?: Array<{ note: string; importance?: number }>;
      soul?: string;
    };
    if (!Array.isArray(parsed.facts)) return false;

    // Rewrite facts + consume the episodes that fed this consolidation.
    await deps.db.delete(agentMemory).where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.kind, "fact")));
    await deps.db.delete(agentMemory).where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.kind, "episode")));
    for (const fact of parsed.facts.slice(0, 25)) {
      if (!fact.note?.trim()) continue;
      const keywords = fact.note
        .toLowerCase()
        .split(/[^a-z0-9ěščřžýáíéúů]+/)
        .filter((w) => w.length >= 3)
        .slice(0, 12)
        .join(",");
      await deps.db.insert(agentMemory).values({
        id: newId(),
        agentId,
        note: fact.note.trim().slice(0, 500),
        kind: "fact",
        importance: Math.min(5, Math.max(1, Math.round(fact.importance ?? 3))),
        keywords,
        createdAt: new Date(),
      });
    }

    // soul.md — the agent's living self-description, injected into every prompt.
    if (parsed.soul?.trim()) {
      const soulPath = path.join(path.dirname(agentSkillsDir(deps.paths, agentId)), "soul.md");
      await fs.mkdir(path.dirname(soulPath), { recursive: true });
      await fs.writeFile(
        soulPath,
        `# Soul\n\n_${new Date().toISOString()}_ — auto-maintained. The agent evolves this itself.\n\n${parsed.soul.trim()}\n`,
        "utf8",
      );
    }

    return true;
  } catch {
    return false;
  } finally {
    consolidating.delete(agentId);
  }
}

/** Loads the agent's soul.md for prompt injection (empty string when absent). */
export async function loadSoul(paths: HertzPaths, agentId: string): Promise<string> {
  try {
    const soulPath = path.join(path.dirname(agentSkillsDir(paths, agentId)), "soul.md");
    const raw = await fs.readFile(soulPath, "utf8");
    return raw.replace(/^# Soul[\s\S]*?_\n/, "").trim();
  } catch {
    return "";
  }
}
