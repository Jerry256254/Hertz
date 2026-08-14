import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { sessionTokens, users } from "../db/schema.js";
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

/** Verifies an opaque bearer/cookie token, refreshing its sliding expiration on use. */
export async function verifySessionToken(db: Database, token: string): Promise<AuthenticatedUser | undefined> {
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
