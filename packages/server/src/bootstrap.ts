import type { SupportedProvider } from "@kuclab-hertz/providers";
import type { AppContext } from "./context.js";
import { newId } from "./db/client.js";
import { agents, users, providerConfigs } from "./db/schema.js";
import { hashPassword } from "./auth/password.js";
import { encryptSecret } from "./secrets/key-encryption.js";
import { defaultAgentPrompt } from "./agents/persona.js";

/** The agent's character prompt — defined in agents/persona.ts (Czech-first). */
export { defaultAgentPrompt };

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

/** The single agent's character — defined in agents/persona.ts (Czech-first persona). Re-exported here for compatibility. */
/* (defaultAgentPrompt is re-exported from ./agents/persona.js above) */

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
