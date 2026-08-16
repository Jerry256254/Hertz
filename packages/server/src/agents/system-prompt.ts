import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentMemory, agents } from "../db/schema.js";
import { recentConversationMessagesFor } from "../conversations.js";

const RECENT_MESSAGE_COUNT = 5;
/** Notes now auto-accumulate every turn (see agent-loop.ts), not just when an agent deliberately calls remember — capped here so the prompt itself doesn't grow unbounded; the full history is still visible via list_memory and the memory dialog in the UI. */
const RECENT_MEMORY_COUNT = 40;

/**
 * Combines an agent's static role prompt with its live persistent memory and
 * any unanswered messages from colleagues. Called fresh on every turn (sessions,
 * meetings, delegated tasks) rather than baked into agents.system_prompt at
 * hire time, since both memory and messages accumulate over time and must
 * show up everywhere that agent works — not just the session they arrived in.
 *
 * For a direct conversation reply run (conversationPeerName set) the colleague
 * block is replaced with an explicit in-thread instruction: the conversation
 * history is already in context and message_employee is withheld, so replying
 * with the same tool would just message yourself.
 */
export async function buildSystemPrompt(
  db: Database,
  agent: { id: string; systemPrompt: string | null },
  opts: { conversationPeerName?: string; mode?: "plan" | "auto" | "autonomous" } = {},
): Promise<string> {
  const recentNotesDesc = await db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.agentId, agent.id))
    .orderBy(desc(agentMemory.createdAt))
    .limit(RECENT_MEMORY_COUNT);
  const notes = [...recentNotesDesc].reverse();

  let prompt = agent.systemPrompt ?? "";

  if (notes.length > 0) {
    const memoryBlock = notes.map((n) => `- ${n.note}`).join("\n");
    prompt += `\n\n## Your persistent memory\nThis carries across every chat, project, and meeting you're part of — the user can see it too. Some entries are auto-captured from what you were told; add your own with remember for anything that deserves a clearer, more durable note, and use forget to prune what's stale.\n${memoryBlock}`;
  }

  if (opts.mode) {
    const modeBlock: Record<"plan" | "auto" | "autonomous", string> = {
      plan: "## Mode: Plan\nYou are in PLAN mode: do NOT call any tools and do NOT touch any files. Think the request through and return a concrete plan — what you would do, in what order, with which tools and team members — or the answer itself if the request is a question. No execution.",
      auto: "## Mode: Auto\nYou work on the task with full tool access. If you genuinely need input that only the user can give (a preference, a decision, missing information), call ask_user and stop — the question appears in the UI and you continue when they answer. For anything you can decide or look up yourself, don't ask: decide and proceed.",
      autonomous:
        "## Mode: Autonomous (goal mode)\nWork autonomously until the goal is complete: no questions, no check-ins, no status reports mid-work. ask_user is not available to you. When something is ambiguous or unspecified, decide yourself from context, state your assumption, and keep going. You stop only when the task is actually done, or when you hit an explicit limit (a stop instruction, a hard deadline, or something genuinely impossible — report that instead of pretending).",
    };
    prompt += `\n\n${modeBlock[opts.mode]}`;
  }

  if (opts.conversationPeerName) {
    prompt += `\n\nYou are in a direct chat with ${opts.conversationPeerName}. The full conversation so far is in your context. Reply directly — your reply is delivered into the chat as your message, so do NOT call message_employee (it is not available here). You may still use other tools if you need to look something up before answering.`;
    return prompt;
  }

  const recentMessages = await recentConversationMessagesFor(db, agent.id, RECENT_MESSAGE_COUNT);

  if (recentMessages.length > 0) {
    const messageBlock = recentMessages.map((m) => `- ${m.fromName}: ${m.body}`).join("\n");
    prompt += `\n\n## Recent messages from colleagues\nUse message_employee to reply. The user can see these too.\n${messageBlock}`;
  }

  return prompt;
}
