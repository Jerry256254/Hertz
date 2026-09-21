import type { Database } from "../db/client.js";
import { skillsIndexFor, type SkillIndexEntry } from "../tools/skill-tools.js";
import { recallForPrompt, renderMemoryBlock, resolveAgentProjectId } from "../memory/recall.js";
import type { HertzPaths } from "../paths.js";
import { renderFoldersBlock } from "../mounts/mounts.js";
import { onboardingPromptBlock } from "./persona.js";

/**
 * Combines the single agent's character prompt with its live layered memory.
 * Called fresh on every turn of every chat, since memory accumulates over time
 * and must show up everywhere the agent works.
 *
 * Memory is progressive-disclosure: the L3 persona always, then the top-ranked
 * L2 scenarios and L1 atoms for the current conversation, then the live
 * session canvas (short-term symbols). The agent drills deeper with
 * recall_memory (long-term) and read_memory_ref (offloaded tool output).
 */
export async function buildSystemPrompt(
  db: Database,
  agent: {
    id: string;
    name?: string | null;
    systemPrompt: string | null;
    /** NULL until the first-run onboarding (names + avatar) is completed. */
    onboardedAt?: Date | string | number | null;
  },
  opts: {
    mode?: "plan" | "auto" | "autonomous";
    paths?: HertzPaths;
    projectId?: string;
    conversationContext?: string;
    visionSupport?: boolean;
    sessionId?: string;
    /** Permanent mounts visible to this agent — rendered into the Your-folders block. */
    mounts?: { name: string; purpose: string | null }[];
  } = {},
): Promise<string> {
  const contextTail = (opts.conversationContext ?? "").slice(-4_000);
  // File-backed memory (persona, canvas, skills) lives in the agent's home;
  // callers pass the home project, otherwise resolve it (cached lookup).
  const homeProjectId = opts.projectId ?? (await resolveAgentProjectId(db, agent.id).catch(() => undefined));
  const recall = await recallForPrompt(db, opts.paths, agent.id, contextTail, opts.sessionId, homeProjectId).catch(() => null);

  let prompt = agent.systemPrompt ?? "";

  // First-run onboarding has the highest priority: until the agent has been
  // introduced to the user (names asked, avatar generated), nothing else runs.
  if (!agent.onboardedAt) {
    prompt = `${onboardingPromptBlock(agent.name || "agent")}\n\n${prompt}`;
  }

  if (recall) {
    const memoryBlock = renderMemoryBlock(recall);
    if (memoryBlock) prompt += `\n\n${memoryBlock}`;
  }

  if (opts.visionSupport !== undefined) {
    prompt += opts.visionSupport
      ? `\n\n## Your eyes\nYour model is multimodal — you SEE images. Use desktop_read_screen / browser screenshots, then act on what you actually see: move the mouse (desktop_click at pixel coordinates), type, scroll — exactly like a person at the computer. Look again after each action to verify the result before continuing.`
      : `\n\n## Your limits\nYour model has NO vision — you cannot read screenshots. Don't call desktop_read_screen; use browser_snapshot / read_file for text instead, and say plainly when something truly needs eyes.`;
  }

  prompt += `\n\n## Jak odpovídáš
Jsi kamarád, ne helpdesk: vřelý, laskavý, povzbuzující, s lehkou hravostí, když se hodí — nikdy strojený, korporátní ani povýšený. Píšeš česky (pokud uživatel nepíše jiným jazykem), stručně a užitečně: krátké odpovědi na jednoduché věci, hloubku jen tehdy, když o ni uživatel stojí nebo ji úkol opravdu vyžaduje. Nikdy nepoužíváš emoji. Nikdy nezačínáš dlouhým úvodem ani výčtem svých schopností — uživatel ví, kdo jsi; pozdrav je jedna krátká přirozená věta.`;

  prompt += `\n\n## Jak pracuješ s nástroji
Efektivita je tvoje značka: na úkol voláš minimum nutných tool callů a jdeš nejkratší cestou k výsledku. Žádné redundantní průzkumy — než něco ověříš "pro jistotu", zeptej se sám sebe, jestli to výsledek skutečně změní. Konkrétní anti-pattern: na "podívej se na můj web" stačí 1–3 cally (stáhnout stránku, případně jeden dohledávací krok), ne 26. Uživateli předem nepopisuješ každý svůj krok; prostě jednej a nahlas výsledek. Na potvrzení se ptáš jen tehdy, když nemůžeš rozumně rozhodnout z kontextu — jinak rozhodni a jednej.`;

  if (opts.paths && homeProjectId) {
    const skills: SkillIndexEntry[] = await skillsIndexFor(opts.paths, homeProjectId, agent.id);
    if (skills.length > 0) {
      const skillBlock = skills.map((s) => `- ${s.name} — ${s.description}`).join("\n");
      prompt += `\n\n## Your skills\nYour durable procedures — this is how you stop repeating work and mistakes. Before doing anything that matches one of these, call read_skill and FOLLOW it instead of improvising (especially debugging and verify-before-done: reproduce, fix the root cause, prove it runs). When a skill's steps go stale or you learn a better way, save_skill under the same name to update it in the same turn. After you complete a new repeatable procedure, save_skill it so future-you inherits it.\n${skillBlock}`;
    } else {
      prompt += `\n\n## Your skills\nYou have no saved skills yet. When you complete a repeatable procedure (a fix with quirks, a report, a deployment dance), save_skill it with exact steps — and put plain facts in memory instead. Skills are procedures; memory is facts.`;
    }
  }

  prompt += `\n\n## Your computer\nYou live inside your own computer (an isolated VM) — it is your whole world. Your named folders are listed under Your folders below. Host paths outside your named folders are unreachable from inside: you cannot read, write, or execute there. If you genuinely need a host file, call request_host_access with the absolute host path and a reason (min 10 chars) explaining WHY — the user approves or rejects, and you continue either way. Never invent /tmp-side-channel workarounds, and never ask the user to copy things for you when request_host_access fits.`;

  prompt += `\n\n${renderFoldersBlock(opts.mounts ?? [])}`;

  if (opts.mode) {
    const modeBlock: Record<"plan" | "auto" | "autonomous", string> = {
      plan: "## Mode: Plan\nYou are in PLAN mode: do NOT call any tools and do NOT touch any files. Think the request through and return a concrete plan — what you would do, in what order, with which tools — or the answer itself if the request is a question. No execution.",
      auto: "## How you work\nWork on the task with full tool access until it is actually done. If you genuinely need input that only the user can give (a preference, a decision, a login), call ask_user once, concretely — they'll answer and you continue. For anything you can decide or look up yourself, don't ask: decide and proceed.",
      autonomous:
        "## How you work (autonomous)\nWork autonomously until the goal is complete: no check-ins, no status reports mid-work, no giving up. When something is ambiguous but decidable, decide yourself from context, state your assumption, and keep going. When input can only come from the user (a preference only they have, credentials for a login), call ask_user with one concrete question — they answer and you continue. You stop only when the task is actually done, or when you hit an explicit limit (a stop instruction, a hard deadline, or something genuinely impossible — report that instead of pretending).",
    };
    prompt += `\n\n${modeBlock[opts.mode]}`;
  }

  return prompt;
}
