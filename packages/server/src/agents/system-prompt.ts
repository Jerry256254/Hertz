import type { Database } from "../db/client.js";
import { recentConversationMessagesFor } from "../conversations.js";
import { skillsIndexFor, type SkillIndexEntry } from "../tools/skill-tools.js";
import { recallForPrompt, renderMemoryBlock } from "../memory/recall.js";
import type { HertzPaths } from "../paths.js";

const RECENT_MESSAGE_COUNT = 5;

/**
 * Combines an agent's static role prompt with its live layered memory and
 * any unanswered messages from colleagues. Called fresh on every turn (sessions,
 * meetings, delegated tasks) rather than baked into agents.system_prompt at
 * hire time, since both memory and messages accumulate over time and must
 * show up everywhere that agent works — not just the session they arrived in.
 *
 * Memory is progressive-disclosure: the L3 persona always, then the top-ranked
 * L2 scenarios and L1 atoms for the current conversation, then the live
 * session canvas (short-term symbols). The agent drills deeper with
 * recall_memory (long-term) and read_memory_ref (offloaded tool output).
 *
 * For a direct conversation reply run (conversationPeerName set) the colleague
 * block is replaced with an explicit in-thread instruction: the conversation
 * history is already in context and message_employee is withheld, so replying
 * with the same tool would just message yourself.
 */
export async function buildSystemPrompt(
  db: Database,
  agent: { id: string; systemPrompt: string | null },
  opts: { conversationPeerName?: string; mode?: "plan" | "auto" | "autonomous"; paths?: HertzPaths; conversationContext?: string; visionSupport?: boolean; sessionId?: string } = {},
): Promise<string> {
  const contextTail = (opts.conversationContext ?? "").slice(-4_000);
  const recall = await recallForPrompt(db, opts.paths, agent.id, contextTail, opts.sessionId).catch(() => null);

  let prompt = agent.systemPrompt ?? "";

  if (recall) {
    const memoryBlock = renderMemoryBlock(recall);
    if (memoryBlock) prompt += `\n\n${memoryBlock}`;
  }

  if (opts.visionSupport !== undefined) {
    prompt += opts.visionSupport
      ? `\n\n## Your eyes\nYour model is multimodal — you SEE images. Use desktop_read_screen / browser screenshots, then act on what you actually see: move the mouse (desktop_click at pixel coordinates), type, scroll — exactly like a person at the computer. Look again after each action to verify the result before continuing.`
      : `\n\n## Your limits\nYour model has NO vision — you cannot read screenshots. Don't call desktop_read_screen; use browser_snapshot / read_file for text instead, and say plainly when something truly needs eyes.`;
  }

  if (opts.paths) {
    const skills: SkillIndexEntry[] = await skillsIndexFor(opts.paths, agent.id);
    if (skills.length > 0) {
      const skillBlock = skills.map((s) => `- ${s.name} — ${s.description}`).join("\n");
      prompt += `\n\n## Your skills\nProcedures you saved from earlier work. Before doing anything that matches one of these, call read_skill and follow it instead of improvising. After you complete a new repeatable procedure, offer or just save_skill it.\n${skillBlock}`;
    }
  }

  if (opts.mode) {
    const modeBlock: Record<"plan" | "auto" | "autonomous", string> = {
      plan: "## Mode: Plan\nYou are in PLAN mode: do NOT call any tools and do NOT touch any files. Think the request through and return a concrete plan — what you would do, in what order, with which tools and team members — or the answer itself if the request is a question. No execution.",
      auto: "## How you work\nWork on the task with full tool access until it is actually done. If you genuinely need input that only the user can give (a preference, a decision, a login), call ask_user once, concretely — they'll answer and you continue. For anything you can decide or look up yourself, don't ask: decide and proceed.",
      autonomous:
        "## How you work (autonomous)\nWork autonomously until the goal is complete: no check-ins, no status reports mid-work, no giving up. When something is ambiguous but decidable, decide yourself from context, state your assumption, and keep going. When input can only come from the user (a preference only they have, credentials for a login), call ask_user with one concrete question — they answer and you continue. You stop only when the task is actually done, or when you hit an explicit limit (a stop instruction, a hard deadline, or something genuinely impossible — report that instead of pretending).",
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
