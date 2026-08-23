import { CronExpressionParser } from "cron-parser";
import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agents, routines, sessions } from "../db/schema.js";
import type { JobQueue } from "../queue/job-queue.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";

export type RoutineSchedule = "once" | "daily" | "weekly" | string;

/**
 * Turns a schedule value into a real cron expression, anchored to `now`'s
 * time-of-day (and, for weekly, day-of-week) — so "daily"/"weekly" mean "same
 * time as when this was created", not a fixed arbitrary hour. Anything else is
 * passed straight through to cron-parser as a raw 5-field expression.
 */
export function normalizeSchedule(schedule: RoutineSchedule, now: Date): string {
  if (schedule === "daily") return `${now.getUTCMinutes()} ${now.getUTCHours()} * * *`;
  if (schedule === "weekly") return `${now.getUTCMinutes()} ${now.getUTCHours()} * * ${now.getUTCDay()}`;
  return schedule;
}

/**
 * `schedule` must already be normalized (a real cron expression, or the literal
 * "once"). Pinned to UTC so it agrees with normalizeSchedule's getUTCHours/
 * getUTCMinutes/getUTCDay — without this, cron-parser evaluates fields against
 * the host's local timezone, which silently drifts the schedule by whatever
 * that offset is (caught by a smoke test: "daily" fired ~22h out, not ~24h, on
 * a UTC+2 host).
 */
export function computeNextRun(schedule: string, from: Date): Date | undefined {
  if (schedule === "once") return undefined;
  return CronExpressionParser.parse(schedule, { currentDate: from, tz: "UTC" }).next().toDate();
}

export interface RoutineSchedulerDeps {
  db: Database;
  queue: JobQueue;
  fallbackUserId: () => Promise<string>;
}

/**
 * Creates a fresh session for one firing and enqueues it on the durable queue.
 * Shared by the routine scheduler and (via fireRoutineForAgent) any other
 * scheduler that wants identical firing semantics.
 */
export async function fireRoutine(deps: RoutineSchedulerDeps, routine: typeof routines.$inferSelect, now: Date): Promise<void> {
  const { db, queue, fallbackUserId } = deps;

  const agentRows = await db.select().from(agents).where(eq(agents.id, routine.agentId)).limit(1);
  const agent = agentRows[0];
  if (!agent || agent.approvalStatus !== "approved" || agent.status === "terminated") {
    // Dead target: disable instead of retrying forever.
    await db.update(routines).set({ enabled: false }).where(eq(routines.id, routine.id));
    return;
  }

  const sessionId = newId();
  await db.insert(sessions).values({
    id: sessionId,
    agentId: agent.id,
    projectId: routine.projectId,
    title: routine.title,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  await enqueueAgentRun(
    { queue },
    {
      sessionId,
      userId: await fallbackUserId(),
      mode: "autonomous",
      userMessage: [
        {
          type: "text",
          text: `This is a scheduled routine ("${routine.title}") — run it now.\n\n${routine.taskTemplate}`,
        },
      ],
    },
    { maxAttempts: 3 },
  );

  const isOneOff = routine.schedule === "once";
  await db
    .update(routines)
    .set({
      lastRunAt: now,
      nextRunAt: isOneOff ? null : computeNextRun(routine.schedule, now),
      enabled: isOneOff ? false : routine.enabled,
    })
    .where(eq(routines.id, routine.id));
}

/**
 * Polls `routines.nextRunAt` from the DB rather than keeping in-memory timers
 * per routine, so a server restart doesn't drop a scheduled run — the next
 * tick after boot picks up anything that was due while the server was down.
 * Firings go through the durable job queue instead of running inline in the
 * interval handler.
 */
export class RoutineScheduler {
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RoutineSchedulerDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const due = await this.deps.db
      .select()
      .from(routines)
      .where(and(eq(routines.enabled, true), lte(routines.nextRunAt, now)));
    for (const routine of due) {
      try {
        await fireRoutine(this.deps, routine, now);
      } catch {
        // A single routine's failure to launch shouldn't stop the rest from checking in.
      }
    }
  }
}
