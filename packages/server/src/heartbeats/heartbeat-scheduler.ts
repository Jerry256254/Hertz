import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agents, sessions } from "../db/schema.js";
import type { JobQueue } from "../queue/job-queue.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";

export const HEARTBEAT_SESSION_TITLE = "Heartbeat";

export interface HeartbeatSchedulerDeps {
  db: Database;
  queue: JobQueue;
}

function heartbeatBrief(agent: typeof agents.$inferSelect): string {
  const lines = [
    "[Heartbeat] This is your periodic self-check — nobody sent a message; you woke yourself up.",
    "Use it to make progress on anything you own that's stalled, check whatever you've been asked to watch, or prepare something useful.",
    "If there is genuinely nothing worth doing, reply with exactly \"(idle)\" and finish — don't invent work, don't repeat earlier reports.",
    agent.heartbeatPrompt?.trim()
      ? `\nYour standing heartbeat instructions:\n${agent.heartbeatPrompt.trim()}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * OpenClaw-style heartbeats: each agent with heartbeat_minutes > 0 wakes itself
 * up on an interval and decides whether to act, report, or stay quiet. Firing
 * goes through the durable queue; the tick itself only flips last_heartbeat_at
 * and enqueues, so bursts never pile up inside the interval handler.
 */
export class HeartbeatScheduler {
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: HeartbeatSchedulerDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const now = new Date();
    const candidates = await this.deps.db
      .select()
      .from(agents)
      .where(
        and(
          sql`${agents.heartbeatMinutes} > 0`,
          eq(agents.approvalStatus, "approved"),
          ne(agents.status, "terminated"),
        ),
      );
    for (const agent of candidates) {
      const intervalMs = agent.heartbeatMinutes * 60_000;
      if (agent.lastHeartbeatAt && now.getTime() - agent.lastHeartbeatAt.getTime() < intervalMs) continue;
      try {
        await this.fire(agent, now);
      } catch {
        // One broken agent shouldn't starve the others' heartbeats.
      }
    }
  }

  private async fire(agent: typeof agents.$inferSelect, now: Date): Promise<void> {
    const { db, queue } = this.deps;

    // One rolling heartbeat thread per agent keeps proactivity inspectable —
    // everything the bot did on its own initiative lives in one session.
    const existing = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.agentId, agent.id), eq(sessions.title, HEARTBEAT_SESSION_TITLE)))
      .limit(1);

    let sessionId = existing[0]?.id;
    if (!sessionId) {
      sessionId = newId();
      await db.insert(sessions).values({
        id: sessionId,
        agentId: agent.id,
        projectId: agent.projectId,
        title: HEARTBEAT_SESSION_TITLE,
        mode: "autonomous",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }

    await enqueueAgentRun(
      { queue },
      {
        sessionId,
        mode: "autonomous",
        userMessage: [{ type: "text", text: heartbeatBrief(agent) }],
        suppressAutoMemory: true,
      },
      { maxAttempts: 1 },
    );

    // Advance the clock even if the run later fails — a dead provider shouldn't
    // turn into an enqueue storm every minute.
    await db.update(agents).set({ lastHeartbeatAt: now }).where(eq(agents.id, agent.id));
  }
}
