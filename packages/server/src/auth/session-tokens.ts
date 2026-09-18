import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { apiTokens, sessionTokens, users } from "../db/schema.js";
import { newId } from "../db/client.js";

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, refreshed on activity

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSessionToken(db: Database, userId: string): Promise<string> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const now = new Date();
  await db.insert(sessionTokens).values({
    id: newId(),
    userId,
    tokenHash: hashToken(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    lastUsedAt: now,
  });
  return token;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: "admin" | "user";
}

/** Verifies an opaque bearer/cookie token, refreshing its sliding expiration on use. Also accepts long-lived API tokens (htz_…). */
export async function verifySessionToken(db: Database, token: string): Promise<AuthenticatedUser | undefined> {
  if (token.startsWith("htz_")) return verifyApiToken(db, token);
  const tokenHash = hashToken(token);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      expiresAt: sessionTokens.expiresAt,
      tokenId: sessionTokens.id,
    })
    .from(sessionTokens)
    .innerJoin(users, eq(sessionTokens.userId, users.id))
    .where(eq(sessionTokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;
  if (row.expiresAt.getTime() < Date.now()) return undefined;

  const now = new Date();
  await db
    .update(sessionTokens)
    .set({ lastUsedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .where(eq(sessionTokens.id, row.tokenId));

  return { id: row.id, email: row.email, role: row.role as "admin" | "user" };
}

export async function revokeSessionToken(db: Database, token: string): Promise<void> {
  await db.delete(sessionTokens).where(eq(sessionTokens.tokenHash, hashToken(token)));
}

export const API_TOKEN_PREFIX = "htz_";

/** Creates a long-lived API token; the raw value is returned once and never stored. */
export async function createApiToken(db: Database, userId: string, name: string): Promise<{ id: string; token: string }> {
  const token = `${API_TOKEN_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
  const id = newId();
  await db.insert(apiTokens).values({
    id,
    userId,
    name,
    tokenHash: hashToken(token),
    prefixHint: token.slice(0, 12),
    createdAt: new Date(),
  });
  return { id, token };
}

async function verifyApiToken(db: Database, token: string): Promise<AuthenticatedUser | undefined> {
  const rows = await db
    .select({ id: users.id, email: users.email, role: users.role, tokenId: apiTokens.id })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(and(eq(apiTokens.tokenHash, hashToken(token)), isNull(apiTokens.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.tokenId));
  return { id: row.id, email: row.email, role: row.role as "admin" | "user" };
}

export async function revokeApiToken(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .returning({ id: apiTokens.id });
  return rows.length > 0;
}
