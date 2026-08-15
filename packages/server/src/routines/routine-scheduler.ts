import { CronExpressionParser } from "cron-parser";
import { and, eq, lte } from "drizzle-orm";
import type { AgentLoopManager } from "@kuclab-hertz/core";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agents, projectRoots, routines, sessions } from "../db/schema.js";
import type { SandboxRegistry } from "../sandbox/sandbox-registry.js";
import { employeeDir, ensureEmployeeDirs, type HertzPaths } from "../paths.js";
import { buildSystemPrompt } from "../agents/system-prompt.js";

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
  paths: HertzPaths;
  sandboxRegistry: SandboxRegistry;
  agentLoop: AgentLoopManager;
  fallbackUserId: () => Promise<string>;
}

/**
 * Polls `routines.nextRunAt` from the DB rather than keeping in-memory timers
 * per routine, so a server restart doesn't drop a scheduled run — the next
 * tick after boot picks up anything that was due while the server was down.
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
        await this.runOnce(routine, now);
      } catch {
        // A single routine's failure to launch shouldn't stop the rest from checking in.
      }
    }
  }

  private async runOnce(routine: typeof routines.$inferSelect, now: Date): Promise<void> {
    const { db, sandboxRegistry, paths, agentLoop } = this.deps;

    const agentRows = await db.select().from(agents).where(eq(agents.id, routine.agentId)).limit(1);
    const agent = agentRows[0];
    const rootRows = await db.select().from(projectRoots).where(eq(projectRoots.projectId, routine.projectId));
    const mainRoot = rootRows.find((r) => r.rootId === "main") ?? rootRows[0];

    if (agent && mainRoot) {
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

      await ensureEmployeeDirs(paths, routine.projectId, agent.id);
      sandboxRegistry.register(sessionId, {
        [mainRoot.rootId]: mainRoot.absolutePath,
        self: employeeDir(paths, routine.projectId, agent.id),
      });

      const content: ContentBlock[] = [
        { type: "text", text: `This is a scheduled routine ("${routine.title}") — run it now.\n\n${routine.taskTemplate}` },
      ];
      agentLoop.start(
        {
          sessionId,
          agentId: agent.id,
          projectId: routine.projectId,
          userId: await this.deps.fallbackUserId(),
          rootId: mainRoot.rootId,
          model: agent.model,
          providerConfigId: agent.providerConfigId,
          systemPrompt: await buildSystemPrompt(db, agent),
        },
        content,
      );
    }

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
}
