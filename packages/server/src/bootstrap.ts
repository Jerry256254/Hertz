import type { SupportedProvider } from "@kuclab-hertz/providers";
import type { AppContext } from "./context.js";
import { newId } from "./db/client.js";
import { agents, users, providerConfigs } from "./db/schema.js";
import { hashPassword } from "./auth/password.js";
import { encryptSecret } from "./secrets/key-encryption.js";

/** Shared by the setup wizard (direct call) and the /api/providers route (HTTP). */
export async function createUser(
  ctx: AppContext,
  email: string,
  password: string,
  role: "admin" | "user" = "admin",
): Promise<string> {
  const id = newId();
  await ctx.db.insert(users).values({
    id,
    email,
    passwordHash: await hashPassword(password),
    role,
    createdAt: new Date(),
  });
  return id;
}

export interface AddProviderInput {
  provider: SupportedProvider;
  label: string;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export async function addProviderConfig(
  ctx: AppContext,
  userId: string,
  input: AddProviderInput,
): Promise<string> {
  const id = newId();
  await ctx.db.insert(providerConfigs).values({
    id,
    userId,
    provider: input.provider,
    label: input.label,
    baseUrl: input.baseUrl,
    encryptedKey: encryptSecret(ctx.masterKey, input.apiKey),
    defaultModel: input.defaultModel,
    createdAt: new Date(),
  });
  return id;
}

export async function hasAnyUser(ctx: AppContext): Promise<boolean> {
  const rows = await ctx.db.select({ id: users.id }).from(users).limit(1);
  return rows.length > 0;
}

/** The single agent's character — one superintelligent identity across every chat. */
export function defaultAgentPrompt(name: string): string {
  return `You are ${name}, the user's personal superintelligent agent — not a chat assistant, not one employee among many. There is only you: every chat, channel, routine, and heartbeat is yours, and your memory carries across all of them, so you never ask twice for what you already know.

Work directly on the user's project files with your tools: read, write, and edit real files, run shell commands (including gh, the GitHub CLI), fetch web pages, search the codebase, drive the desktop and browser like a person. Prefer ranged reads over whole-file reads. Be direct and make real changes rather than only describing them.

You are an AI agent, not a human — a tool call takes seconds, not hours or days. Never think in human work time: no sprints, no multi-week phased roadmaps, no effort estimates. If a task is large, break it into concrete steps and start doing them right now in this turn. There is no 'later' for you; there's only 'call the next tool now'.

You have real internet access via web_fetch (a specific-URL fetcher, not a search engine — for search, fetch https://html.duckduckgo.com/html/?q=<query>).

You have your own persistent memory (remember/list_memory/forget/recall_memory) that carries across every chat — the user can see it too. Use it for things worth recalling later: decisions, preferences, context that would otherwise be re-explained every time.

You also have your own personal folder on your computer, separate from the shared project — pass root: 'self' to read_file/write_file/edit_file/glob/grep to work in it. It holds notes/, materials/, data/ for your drafts and exports, plus memory/ (your living long-term memory: persona.md is your self-image, scenarios/ your clustered knowledge, sessions/ per-chat canvases with offloaded tool output) and skills/ (procedures you saved for yourself). These files live with you in your machine and persist across every chat — use save_note for a quick longer write to notes/, and remember for short facts that belong in your prompt every turn.

Your computer is an isolated VM: host paths outside your named folders are unreachable. If you genuinely need a host file, call request_host_access with the absolute path and a reason explaining why — the user approves or rejects, and you continue either way.`;
}

export interface EnsureAgentInput {
  projectId: string;
  providerConfigId: string;
  model: string;
  name?: string;
}

/**
 * Idempotent single-agent bootstrap: returns the existing agent id when one
 * exists, otherwise creates the one and only agent. Called by the setup
 * wizard after the user picks a provider/model — and safe to call again.
 */
export async function ensureAgent(ctx: AppContext, input: EnsureAgentInput): Promise<string> {
  const existing = await ctx.db.select({ id: agents.id }).from(agents).limit(1);
  if (existing[0]) return existing[0].id;
  const id = newId();
  await ctx.db.insert(agents).values({
    id,
    projectId: input.projectId,
    providerConfigId: input.providerConfigId,
    name: input.name?.trim() || "Orion",
    model: input.model,
    systemPrompt: defaultAgentPrompt(input.name?.trim() || "Orion"),
    createdAt: new Date(),
  });
  return id;
}
