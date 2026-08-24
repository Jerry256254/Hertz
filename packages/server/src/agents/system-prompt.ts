import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentMemory, agents } from "../db/schema.js";
import { recentConversationMessagesFor } from "../conversations.js";
import { skillsIndexFor, type SkillIndexEntry } from "../tools/skill-tools.js";
import { loadSoul } from "../memory/consolidation.js";
import type { HertzPaths } from "../paths.js";

const RECENT_MESSAGE_COUNT = 5;
/** Max memory entries injected into the prompt (selected by relevance, not recency). */
const MEMORY_PROMPT_LIMIT = 30;

/**
 * Layered-memory retrieval: scores every entry by importance, recency decay,
 * and keyword overlap with the current conversation tail, then injects the
 * top matches. Episodes ("was told X — did Y") age out fast; deliberate facts
 * and preferences stay competitive much longer. Also refreshes lastUsedAt for
 * what was injected so the user can see what memory is actually being used.
 */
function selectRelevantMemories(
  rows: Array<typeof agentMemory.$inferSelect>,
  contextText: string,
  limit = MEMORY_PROMPT_LIMIT,
): Array<typeof agentMemory.$inferSelect> {
  const now = Date.now();
  const contextWords = new Set(
    contextText
      .toLowerCase()
      .split(/[^a-z0-9ěščřžýáíéúů]+/)
      .filter((w) => w.length >= 4),
  );

  const scored = rows.map((row) => {
    const ageDays = Math.max(0, (now - row.createdAt.getTime()) / 86_400_000);
    // Half-life: episodes fade in ~3 days, facts/preferences in ~30.
    const halfLifeDays = row.kind === "episode" ? 3 : row.kind === "preference" ? 120 : 30;
    const recency = Math.pow(0.5, ageDays / halfLifeDays);

    let keywordBoost = 0;
    if (contextWords.size > 0 && row.keywords) {
      for (const kw of row.keywords.split(",")) {
        if (kw && contextWords.has(kw)) keywordBoost += 1;
      }
      keywordBoost = Math.min(keywordBoost, 4) / 2; // up to +2.0
    }

    return { row, score: row.importance * 0.8 + recency * 2 + keywordBoost };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime())
    .map((s) => s.row);
}

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
  opts: { conversationPeerName?: string; mode?: "plan" | "auto" | "autonomous"; paths?: HertzPaths; conversationContext?: string; visionSupport?: boolean } = {},
): Promise<string> {
  const allNotesDesc = await db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.agentId, agent.id))
    .orderBy(desc(agentMemory.createdAt))
    .limit(400);
  // Relevance-ranked injection: importance + recency + keyword overlap with
  // the current conversation, instead of blindly appending the last 40 rows.
  const contextTail = (opts.conversationContext ?? "").slice(-4_000);
  const notes = selectRelevantMemories([...allNotesDesc].reverse(), contextTail);

  let prompt = agent.systemPrompt ?? "";

  if (opts.paths) {
    const soul = await loadSoul(opts.paths, agent.id);
    if (soul) {
      prompt += `\n\n## Your soul (self-maintained)\n${soul}\nKeep this current — it is your living self-image.`;
    }
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

  if (notes.length > 0) {
    const memoryBlock = notes.map((n) => `- ${n.note}`).join("\n");
    prompt += `\n\n## Your persistent memory\nThis carries across every chat, project, and meeting you're part of — the user can see it too. Some entries are auto-captured from what you were told; add your own with remember for anything that deserves a clearer, more durable note, and use forget to prune what's stale.\n${memoryBlock}`;
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
