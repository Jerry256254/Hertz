import { eq } from "drizzle-orm";
import type { AgentLoopManager, PersistencePort, ProviderPort } from "@kuclab-hertz/core";
import { repairSessionHistory } from "@kuclab-hertz/core";
import type { AuditSink } from "@kuclab-hertz/sandbox";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { Database } from "../db/client.js";
import { agents, projectRoots, sessions } from "../db/schema.js";
import { resolveEffectiveModel, scannedModels } from "./resolve-model.js";
import { mountsFor } from "../mounts/mounts.js";
import type { SandboxRegistry } from "../sandbox/sandbox-registry.js";
import type { HertzPaths } from "../paths.js";
import { employeeDir, ensureEmployeeDirs } from "../paths.js";
import { buildSystemPrompt } from "../agents/system-prompt.js";
import type { JobQueue, JobHandler } from "../queue/job-queue.js";
import type { ComputerManager } from "../computer/computer-manager.js";
import type { DesktopManager } from "../computer/desktop-manager.js";
import { runMemoryPipeline } from "../memory/pipeline.js";

/** Text of the most recent real (non-tool-result) user message — used for memory recall ranking. */
async function extractLastUserText(deps: RunJobsDeps, sessionId: string): Promise<string> {
  try {
    const history = await deps.persistence.listMessages(sessionId);
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i]!;
      if (message.role !== "user" || message.senderAgentId) continue;
      const text = message.content
        .filter((b): b is Extract<import("@kuclab-hertz/providers").ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text.trim()) return text;
    }
  } catch {
    /* fall through */
  }
  return "";
}

/**
 * The one way work gets done: every agent run — human chat, routine,
 * heartbeat, channel inbound, crash recovery — is an "agent_run" job whose
 * handler rebuilds the full AgentLoopConfig from the DB right before
 * executing. Rebuilding late (instead of snapshotting at enqueue time) means
 * memory notes, model changes, and moved project roots are always current
 * when the job finally runs, and the exact same code path serves fresh runs
 * and post-crash resumes.
 */
export interface AgentRunJobPayload {
  sessionId: string;
  /** Attribution override for usage records; falls back to the project owner. */
  userId?: string;
  mode?: "plan" | "auto" | "autonomous";
  excludeTools?: string[];
  /** The triggering message was already persisted by the caller. */
  prePersisted?: boolean;
  /** Persisted as the triggering user message unless prePersisted. */
  userMessage?: ContentBlock[];
  /** Skip the loop's automatic memory note (heartbeats — they'd spam memory every tick). */
  suppressAutoMemory?: boolean;
}

/** Per (providerConfigId, model) → supportsVision cache; providers are asked once. */
const visionCache = new Map<string, boolean>();

async function modelSupportsVision(deps: RunJobsDeps, providerConfigId: string, model: string): Promise<boolean> {
  const key = `${providerConfigId}::${model}`;
  const cached = visionCache.get(key);
  if (cached !== undefined) return cached;
  let value = false;
  try {
    const models = await scannedModels(deps, providerConfigId);
    value = models.find((m) => m.id === model)?.supportsVision ?? false;
  } catch {
    value = false;
  }
  visionCache.set(key, value);
  return value;
}

export interface RunJobsDeps {
  db: Database;
  providers: ProviderPort;
  desktop: DesktopManager;
  paths: HertzPaths;
  sandboxRegistry: SandboxRegistry;
  persistence: PersistencePort;
  agentLoop: AgentLoopManager;
  queue: JobQueue;
  computer: ComputerManager;
  audit: AuditSink;
  fallbackUserId: () => Promise<string>;
}

/**
 * Wires the agent's "computer" for this run. Docker-backend agents get a
 * dedicated container with the project root + personal dir mounted at host
 * paths. VM-only isolation: when Docker is unavailable the run FAILS LOUDLY
 * (audited + thrown, so the job retries and the user sees a real error) —
 * silently falling back to un-isolated local host execution is forbidden.
 */
async function prepareComputer(deps: RunJobsDeps, agent: typeof agents.$inferSelect, mountPaths: string[]) {
  if (agent.computerBackend !== "docker") return undefined;
  try {
    await deps.computer.ensureContainer({
      agentId: agent.id,
      image: agent.computerImage,
      mountPaths,
    });
    return deps.computer.runtime(agent.id);
  } catch (err) {
    const message = (err as Error).message;
    await deps.audit.record({
      actorId: agent.id,
      actorType: "agent",
      projectId: agent.projectId,
      action: "computer.unavailable",
      target: agent.id,
      targetType: "agent",
      result: "error",
      detail: { error: message },
    });
    throw new Error(`Docker computer unavailable for ${agent.name}: ${message} — refusing to run un-isolated on the host`);
  }
}

export function normalizeSessionMode(mode: string | null | undefined): "plan" | "auto" | "autonomous" {
  // Respect the session's own mode (plan/auto/autonomous) — the answer-flow
  // resume must run in the same mode the session started in. Unknown values
  // fall back to autonomous-first.
  if (mode === "plan" || mode === "auto" || mode === "autonomous") return mode;
  return "autonomous";
}

/** Enqueues an agent run; resolves immediately with the durable job id. */
export async function enqueueAgentRun(
  deps: Pick<RunJobsDeps, "queue">,
  payload: AgentRunJobPayload,
  opts: { runAt?: Date; maxAttempts?: number } = {},
): Promise<string> {
  return deps.queue.enqueue("agent_run", payload as unknown as Record<string, unknown>, opts);
}

export function createAgentRunHandler(deps: RunJobsDeps): JobHandler {
  return async (rawPayload) => {
    const payload = rawPayload as unknown as AgentRunJobPayload;

    const sessionRows = await deps.db.select().from(sessions).where(eq(sessions.id, payload.sessionId)).limit(1);
    const session = sessionRows[0];
    if (!session || session.status === "archived") return;

    const agentRows = await deps.db.select().from(agents).where(eq(agents.id, session.agentId)).limit(1);
    const agent = agentRows[0];
    if (!agent) return;

    // Stale model ids are corrected here (persisted), so the run never dies
    // at stream time with "unsupported model name".
    const model = await resolveEffectiveModel(deps, agent);

    const mode = payload.mode ?? normalizeSessionMode(session.mode);
    const excludeTools = [...(payload.excludeTools ?? [])];

    const rootRows = await deps.db.select().from(projectRoots).where(eq(projectRoots.projectId, session.projectId));
    const mainRoot = rootRows.find((r) => r.rootId === "main") ?? rootRows[0];
    if (!mainRoot) throw new Error(`Project ${session.projectId} has no root directory configured`);

    await ensureEmployeeDirs(deps.paths, session.projectId, agent.id);
    const selfDir = employeeDir(deps.paths, session.projectId, agent.id);
    // The agent's home (his memory/skills) rides into the container too — it
    // is usually the same directory as selfDir, mounted once via the Set.
    await ensureEmployeeDirs(deps.paths, agent.projectId, agent.id);
    const homeDir = employeeDir(deps.paths, agent.projectId, agent.id);
    // Permanent user-approved mounts: extra bind-mounts + extra PathGuard roots.
    const mountRows = await mountsFor(deps.db, session.projectId, agent.id);
    const computer = await prepareComputer(
      deps,
      agent,
      [...new Set([mainRoot.absolutePath, selfDir, homeDir, ...mountRows.map((m) => m.hostPath)])],
    );

    // Every active run gets its visible desktop up (Xvfb + VNC + noVNC), so the
    // user can watch/take over at any moment. Fire-and-forget: never blocks work.
    if (computer && agent.computerBackend === "docker") {
      void deps.desktop.start(agent.id).catch((err: Error) => {
        console.warn(`[hertz] desktop auto-start for ${agent.name}: ${(err as Error).message}`);
      });
    }
    const sandboxRoots: Record<string, string> = {
      [mainRoot.rootId]: mainRoot.absolutePath,
      self: selfDir,
    };
    for (const m of mountRows) sandboxRoots[m.name] = m.hostPath;
    deps.sandboxRegistry.register(
      session.id,
      sandboxRoots,
      computer,
      // The browser daemon rides on the same container; only meaningful when it's up.
      computer && agent.computerBackend === "docker" ? deps.computer.browserSession(agent.id) : undefined,
    );

    // A previous process may have died mid-tool, leaving a dangling tool_use in
    // the history that would get every provider call rejected. Close the gap first.
    await repairSessionHistory(deps.persistence, session.id);

    // Idempotent trigger persistence: a retried job (crash mid-run) must not
    // append its user message twice — if an earlier attempt already stored the
    // exact same trailing message, skip persisting it again.
    let prePersisted = payload.prePersisted ?? false;
    if (!prePersisted && payload.userMessage) {
      const history = await deps.persistence.listMessages(session.id);
      const last = history[history.length - 1];
      if (
        last &&
        last.role === "user" &&
        (last.senderAgentId ?? null) === null &&
        JSON.stringify(last.content) === JSON.stringify(payload.userMessage)
      ) {
        prePersisted = true;
      }
    }

    try {
      await deps.agentLoop.runToCompletion(
        {
          sessionId: session.id,
          agentId: agent.id,
          projectId: session.projectId,
          userId: payload.userId ?? (await deps.fallbackUserId()),
          rootId: mainRoot.rootId,
          model,
          providerConfigId: agent.providerConfigId,
          systemPrompt: await buildSystemPrompt(deps.db, agent, {
            mode,
            paths: deps.paths,
            projectId: agent.projectId,
            sessionId: session.id,
            mounts: mountRows,
            conversationContext: await extractLastUserText(deps, session.id),
            visionSupport: await modelSupportsVision(deps, agent.providerConfigId, model),
          }),
          mode,
          excludeTools: excludeTools.length > 0 ? excludeTools : undefined,
          prePersisted: prePersisted || !payload.userMessage,
          suppressAutoMemory: payload.suppressAutoMemory,
          supportsVision: await modelSupportsVision(deps, agent.providerConfigId, model),
        },
        payload.userMessage ?? [],
      );
    } finally {
      // Release the session's sandbox bundle — never while a run is still in
      // flight (a duplicate job registers its own bundle, fails fast on
      // "already running", and must not pull the rug from the live run).
      if (!deps.agentLoop.isRunning(session.id)) {
        deps.sandboxRegistry.unregister(session.id);
      }
    }

    // Layered memory: distill this run's turns into atoms (L1), re-cluster
    // scenarios (L2), and refresh the persona (L3) — each on its own cadence.
    // Fire-and-forget.
    void runMemoryPipeline(
      { db: deps.db, paths: deps.paths, providers: deps.providers },
      agent.id,
      session.id,
    ).catch(() => {});
  };
}
