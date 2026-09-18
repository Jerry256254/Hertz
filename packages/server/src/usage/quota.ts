import { and, eq, gte } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { usageRecords, users } from "../db/schema.js";

export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** AI spend (USD) attributed to the user since the 1st of the current month (UTC). */
export async function monthlySpend(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ cost: usageRecords.cost })
    .from(usageRecords)
    .where(and(eq(usageRecords.userId, userId), gte(usageRecords.at, monthStartUtc())));
  return rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);
}

export interface BudgetCheck {
  allowed: boolean;
  spend: number;
  budget: number | null;
}

/** Null budget = unlimited. Runs triggered by the user past the cap are rejected. */
export async function checkBudget(db: Database, userId: string): Promise<BudgetCheck> {
  const rows = await db.select({ monthlyBudgetUsd: users.monthlyBudgetUsd }).from(users).where(eq(users.id, userId)).limit(1);
  const budget = rows[0]?.monthlyBudgetUsd ?? null;
  const spend = await monthlySpend(db, userId);
  return { allowed: budget == null || spend < budget, spend, budget };
}
