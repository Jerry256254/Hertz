import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { approvals } from "../db/schema.js";

/**
 * How long a pending approval may wait for the user's decision before it is
 * treated as rejected. Ten minutes is long enough to read the card on the
 * phone, short enough that the agent isn't parked forever.
 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ExpiredApproval {
  id: string;
  sessionId: string;
  summary: string;
}

/**
 * Finds pending approvals older than the TTL and marks them rejected in one
 * atomic step each (the status=pending predicate keeps a concurrent user
 * decision from being overwritten). Returns the expired ones so the caller
 * can notify the user and resume the parked session.
 */
export async function reapExpiredApprovals(db: Database, ttlMs = APPROVAL_TTL_MS): Promise<ExpiredApproval[]> {
  const cutoff = new Date(Date.now() - ttlMs);
  const rows = await db
    .select({ id: approvals.id, sessionId: approvals.sessionId, summary: approvals.summary })
    .from(approvals)
    .where(and(eq(approvals.status, "pending"), lt(approvals.createdAt, cutoff)));
  for (const row of rows) {
    await db
      .update(approvals)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")));
  }
  return rows;
}
