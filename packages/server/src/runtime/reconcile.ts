import { and, eq, or } from "drizzle-orm";
import { jobs, messages, sessions } from "../db/schema.js";
import type { RunJobsDeps } from "./run-jobs.js";
import { enqueueAgentRun } from "./run-jobs.js";

/**
 * Boot reconciliation — the piece that makes Hertz survive restarts like a
 * 24/7 platform instead of leaking zombie sessions:
 *
 * 1. Jobs found 'running' are requeued (the process that held them is gone).
 * 2. Sessions left status='active' were mid-run when the previous process
 *    died; each gets an agent_run job with just a sessionId, so the handler
 *    rebuilds everything from the DB and the loop continues where it stopped
 *    (repairSessionHistory closes any dangling tool call first).
 *
 * Deliberately NOT resumed: 'awaiting_input' (waiting on a human answer) and
 * 'paused' (the user parked it on purpose — resumable from the UI).
 */
export async function reconcileOnBoot(deps: RunJobsDeps): Promise<{ requeuedJobs: number; resumedSessions: number }> {
  const requeuedJobs = await deps.queue.recoverStaleRunning();

  // Sessions whose runs are already back in the queue (the crashed job was
  // just requeued) must NOT get a second resume job — that would double-persist
  // the triggering message and run two loops against one thread.
  const pendingJobs = await deps.db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.type, "agent_run"), or(eq(jobs.status, "queued"), eq(jobs.status, "running"))));
  const busySessions = new Set<string>();
  for (const row of pendingJobs) {
    try {
      const parsed = JSON.parse(row.payload) as { sessionId?: string };
      if (parsed.sessionId) busySessions.add(parsed.sessionId);
    } catch {
      /* malformed payload — ignore */
    }
  }

  const stale = await deps.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.status, "active"));
  let resumedSessions = 0;
  for (const session of stale) {
    if (busySessions.has(session.id)) continue;
    const anyMessage = await deps.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.sessionId, session.id))
      .limit(1);
    if (anyMessage.length === 0) {
      await deps.db.update(sessions).set({ status: "completed", updatedAt: new Date() }).where(eq(sessions.id, session.id));
      continue;
    }
    await enqueueAgentRun(deps, { sessionId: session.id }, { maxAttempts: 2 });
    resumedSessions++;
  }

  return { requeuedJobs, resumedSessions };
}
