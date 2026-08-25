import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { jobs } from "../db/schema.js";

/**
 * A durable work queue backed by the `jobs` table. Everything an agent does
 * (interactive chat turn, routine firing, delegated task, heartbeat, channel
 * inbound) becomes a job row BEFORE it executes, so:
 * - a process crash loses at most the in-flight turn, never the intent;
 * - boot reconciliation can requeue anything found orphaned;
 * - failures retry with backoff instead of vanishing.
 *
 * Single-process by design (Hertz is one self-hosted server); the claim step
 * still guards with a conditional UPDATE so a second worker instance would be
 * safe-ish, but correctness relies on one queue instance per database.
 */
export type JobPayload = Record<string, unknown>;
export type JobHandler = (payload: JobPayload, job: typeof jobs.$inferSelect) => Promise<void>;

export interface JobQueueOptions {
  /** How many jobs may execute simultaneously (each is usually a full agent loop). */
  concurrency?: number;
  pollIntervalMs?: number;
}

const MAX_BACKOFF_MS = 10 * 60_000;

function backoffMs(attempts: number): number {
  return Math.min(5_000 * 3 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly completions = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  private timer?: ReturnType<typeof setInterval>;
  private active = 0;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly db: Database,
    options: JobQueueOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 8;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Enqueues work and resolves with the job id as soon as the row exists. */
  async enqueue(
    type: string,
    payload: JobPayload,
    opts: { runAt?: Date; maxAttempts?: number } = {},
  ): Promise<string> {
    const id = newId();
    const now = new Date();
    await this.db.insert(jobs).values({
      id,
      type,
      payload: JSON.stringify(payload),
      status: "queued",
      maxAttempts: opts.maxAttempts ?? 3,
      runAt: opts.runAt ?? now,
      createdAt: now,
      updatedAt: now,
    });
    this.kick();
    return id;
  }

  /**
   * In-memory completion promise for callers that block on a specific job
   * (a manager's assign_task waiting for its employee). Deliberately not
   * durable: if the process restarts, the caller died with it.
   */
  async whenDone(jobId: string): Promise<void> {
    const rows = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    const row = rows[0];
    if (row?.status === "failed") throw new Error(row.lastError ?? "job failed");
    if (row && row.status !== "queued" && row.status !== "running") return;

    return new Promise<void>((resolve, reject) => {
      this.completions.set(jobId, { resolve, reject });
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get pendingCount(): number {
    return this.active;
  }

  /** Jobs left 'running' by a previous process are requeued once at boot — respects maxAttempts. */
  async recoverStaleRunning(): Promise<number> {
    const stale = await this.db.select().from(jobs).where(eq(jobs.status, "running"));
    if (stale.length === 0) return 0;
    let requeued = 0;
    const now = new Date();
    for (const job of stale) {
      if (job.attempts >= job.maxAttempts) {
        await this.db.update(jobs).set({ status: "failed", lastError: "Exceeded max attempts before crash", updatedAt: now }).where(eq(jobs.id, job.id));
      } else {
        await this.db.update(jobs).set({ status: "queued", runAt: now, updatedAt: now }).where(eq(jobs.id, job.id));
        requeued++;
      }
    }
    return requeued;
  }

  private kick(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.active >= this.concurrency) return;
    const now = new Date();
    const due = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), lte(jobs.runAt, now)))
      .orderBy(asc(jobs.runAt))
      .limit(this.concurrency - this.active);

    for (const job of due) {
      const claimed = await this.db
        .update(jobs)
        .set({ status: "running", startedAt: new Date(), attempts: job.attempts + 1, updatedAt: now })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, "queued")))
        .returning({ id: jobs.id });
      if (claimed.length === 0) continue; // someone else took it
      this.active++;
      void this.execute({ ...job, status: "running", attempts: job.attempts + 1 }).finally(() => {
        this.active--;
        this.kick();
      });
    }
  }

  private async execute(job: typeof jobs.$inferSelect): Promise<void> {
    const handler = this.handlers.get(job.type);
    let payload: JobPayload = {};
    try {
      payload = JSON.parse(job.payload) as JobPayload;
    } catch {
      /* handled below as a failure */
    }

    try {
      if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
      await handler(payload, job);
      await this.db
        .update(jobs)
        .set({ status: "done", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(jobs.id, job.id));
      this.completions.get(job.id)?.resolve();
      this.completions.delete(job.id);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const willRetry = job.attempts < job.maxAttempts;
      await this.db
        .update(jobs)
        .set({
          status: willRetry ? "queued" : "failed",
          lastError: message.slice(0, 2_000),
          runAt: willRetry ? new Date(Date.now() + backoffMs(job.attempts)) : job.runAt,
          finishedAt: willRetry ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      if (willRetry) return;
      this.completions.get(job.id)?.reject(err instanceof Error ? err : new Error(message));
      this.completions.delete(job.id);
    }
  }
}
