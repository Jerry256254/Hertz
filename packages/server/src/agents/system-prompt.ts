import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentMemory } from "../db/schema.js";

/**
 * Combines an agent's static role prompt with its live persistent memory. Called
 * fresh on every turn (sessions, meetings, delegated tasks) rather than baked
 * into agents.system_prompt at hire time, since memory grows over time and must
 * show up everywhere that agent works — not just the session it was written in.
 */
export async function buildSystemPrompt(
  db: Database,
  agent: { id: string; systemPrompt: string | null },
): Promise<string> {
  const notes = await db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.agentId, agent.id))
    .orderBy(asc(agentMemory.createdAt));

  const base = agent.systemPrompt ?? "";
  if (notes.length === 0) return base;

  const memoryBlock = notes.map((n) => `- ${n.note}`).join("\n");
  return `${base}\n\n## Your persistent memory\nThis carries across every chat, project, and meeting you're part of — the user can see it too. Keep it current with remember/forget.\n${memoryBlock}`;
}
