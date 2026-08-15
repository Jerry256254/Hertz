import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentMemory, agents, employeeMessages } from "../db/schema.js";

const RECENT_MESSAGE_COUNT = 5;
/** Notes now auto-accumulate every turn (see agent-loop.ts), not just when an agent deliberately calls remember — capped here so the prompt itself doesn't grow unbounded; the full history is still visible via list_memory and the memory dialog in the UI. */
const RECENT_MEMORY_COUNT = 40;

/**
 * Combines an agent's static role prompt with its live persistent memory and
 * any recent messages from colleagues. Called fresh on every turn (sessions,
 * meetings, delegated tasks) rather than baked into agents.system_prompt at
 * hire time, since both memory and messages accumulate over time and must
 * show up everywhere that agent works — not just the session they arrived in.
 */
export async function buildSystemPrompt(
  db: Database,
  agent: { id: string; systemPrompt: string | null },
): Promise<string> {
  const recentNotesDesc = await db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.agentId, agent.id))
    .orderBy(desc(agentMemory.createdAt))
    .limit(RECENT_MEMORY_COUNT);
  const notes = [...recentNotesDesc].reverse();

  const recentMessages = await db
    .select({ body: employeeMessages.body, createdAt: employeeMessages.createdAt, fromName: agents.name })
    .from(employeeMessages)
    .innerJoin(agents, eq(employeeMessages.fromAgentId, agents.id))
    .where(eq(employeeMessages.toAgentId, agent.id))
    .orderBy(desc(employeeMessages.createdAt))
    .limit(RECENT_MESSAGE_COUNT);

  let prompt = agent.systemPrompt ?? "";

  if (notes.length > 0) {
    const memoryBlock = notes.map((n) => `- ${n.note}`).join("\n");
    prompt += `\n\n## Your persistent memory\nThis carries across every chat, project, and meeting you're part of — the user can see it too. Some entries are auto-captured from what you were told; add your own with remember for anything that deserves a clearer, more durable note, and use forget to prune what's stale.\n${memoryBlock}`;
  }

  if (recentMessages.length > 0) {
    const messageBlock = [...recentMessages]
      .reverse()
      .map((m) => `- ${m.fromName}: ${m.body}`)
      .join("\n");
    prompt += `\n\n## Recent messages from colleagues\nUse message_employee to reply. The user can see these too.\n${messageBlock}`;
  }

  return prompt;
}
