import { asc, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentMemory, agents, employeeMessages } from "../db/schema.js";

const RECENT_MESSAGE_COUNT = 5;

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
  const notes = await db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.agentId, agent.id))
    .orderBy(asc(agentMemory.createdAt));

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
    prompt += `\n\n## Your persistent memory\nThis carries across every chat, project, and meeting you're part of — the user can see it too. Keep it current with remember/forget.\n${memoryBlock}`;
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
