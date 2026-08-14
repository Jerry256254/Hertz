import type { SupportedProvider } from "@kuclab-hertz/providers";
import type { AppContext } from "./context.js";
import { newId } from "./db/client.js";
import { users, providerConfigs } from "./db/schema.js";
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
