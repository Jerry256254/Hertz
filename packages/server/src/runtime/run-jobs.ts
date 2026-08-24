import { eq } from "drizzle-orm";
import type { AgentLoopManager, PersistencePort, ProviderPort } from "@kuclab-hertz/core";
import { repairSessionHistory } from "@kuclab-hertz/core";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { Database } from "../db/client.js";
import { agents, projectRoots, sessions } from "../db/schema.js";
import type { SandboxRegistry } from "../sandbox/sandbox-registry.js";
import type { HertzPaths } from "../paths.js";
import { employeeDir, ensureEmployeeDirs } from "../paths.js";
import { buildSystemPrompt } from "../agents/system-prompt.js";
import type { JobQueue, JobHandler } from "../queue/job-queue.js";
import type { ComputerManager } from "../computer/computer-manager.js";
import type { DesktopManager } from "../computer/desktop-manager.js";
import { runGroupTurn } from "../groups.js";

/** Text of the most recent real (non-tool-result) user message — the group trigger. */
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
 * The one way work gets done: every agent run — human chat, colleague reply,
 * delegated task, routine, heartbeat, channel inbound, crash recovery — is an
 * "agent_run" job whose handler rebuilds the full AgentLoopConfig from the DB
 * right before executing. Rebuilding late (instead of snapshotting at enqueue
 * time) means memory notes, colleague messages, model changes, and moved
 * project roots are always current when the job finally runs, and the exact
 * same code path serves fresh runs and post-crash resumes.
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
  /** Set on direct-conversation replies so the prompt addresses the peer correctly. */
  conversationPeerName?: string;
  /** Skip the loop's automatic memory note (heartbeats — they'd spam memory every tick). */
  suppressAutoMemory?: boolean;
  /** Group chats: answer only as this participant (e.g. the agent who asked a pending question). */
  forceAgentId?: string;
  /** Conversation threads: which agent of the pair answers this turn (defaults to session.agentId). */
  respondAsAgentId?: string;
}

/** Per (providerConfigId, model) → supportsVision cache; providers are asked once. */
const visionCache = new Map<string, boolean>();

async function modelSupportsVision(deps: RunJobsDeps, providerConfigId: string, model: string): Promise<boolean> {
  const key = `${providerConfigId}::${model}`;
  const cached = visionCache.get(key);
  if (cached !== undefined) return cached;
  let value = false;
  try {
    const adapter = await deps.providers.getAdapter(providerConfigId);
    const models = await adapter.listModels();
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
  fallbackUserId: () => Promise<string>;
}

/**
 * Wires the agent's "computer" for this run. Docker-backend agents get a
 * dedicated container with the project root + personal dir mounted at host
 * paths; if Docker isn't available we fail soft to local execution (audited)
 * rather than blocking all work.
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
    console.warn(`[hertz] docker computer unavailable for ${agent.name}: ${(err as Error).message} — falling back to local`);
    return undefined;
  }
}

export function normalizeSessionMode(_mode: string): "autonomous" {
  // Hertz is autonomous-first: every run works until the goal is done and may
  // ask the user only through explicit gates (ask_user / request_approval).
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

    // Group chats fan out inside the same thread: every participant answers in
    // turn (or only the @mentioned ones), sharing one history.
    if (session.kind === "group") {
      const triggerText = await extractLastUserText(deps, session.id);
      await runGroupTurn(deps, session.id, triggerText, payload.forceAgentId);
      return;
    }

    const agentRows = await deps.db
      .select()
      .from(agents)
      .where(eq(agents.id, payload.respondAsAgentId ?? session.agentId))
      .limit(1);
    const agent = agentRows[0];
    if (!agent || agent.approvalStatus !== "approved" || agent.status === "terminated") return;

    const isConversation = session.kind === "conversation";
    const mode = payload.mode ?? normalizeSessionMode(session.mode);
    const excludeTools = [
      ...(payload.excludeTools ?? []),
      ...(isConversation && !(payload.excludeTools ?? []).includes("message_employee") ? ["message_employee"] : []),
    ];

    const rootRows = await deps.db.select().from(projectRoots).where(eq(projectRoots.projectId, session.projectId));
    const mainRoot = rootRows.find((r) => r.rootId === "main") ?? rootRows[0];
    if (!mainRoot) throw new Error(`Project ${session.projectId} has no root directory configured`);

    await ensureEmployeeDirs(deps.paths, session.projectId, agent.id);
    const selfDir = employeeDir(deps.paths, session.projectId, agent.id);
    const computer = await prepareComputer(deps, agent, [mainRoot.absolutePath, selfDir]);

    // Every active run gets its visible desktop up (Xvfb + VNC + noVNC), so the
    // user can watch/take over at any moment. Fire-and-forget: never blocks work.
    if (computer && agent.computerBackend === "docker") {
      void deps.desktop.start(agent.id).catch((err: Error) => {
        console.warn(`[hertz] desktop auto-start for ${agent.name}: ${(err as Error).message}`);
      });
    }
    deps.sandboxRegistry.register(
      session.id,
      {
        [mainRoot.rootId]: mainRoot.absolutePath,
        self: selfDir,
      },
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

    await deps.agentLoop.runToCompletion(
      {
        sessionId: session.id,
        agentId: agent.id,
        projectId: session.projectId,
        userId: payload.userId ?? (await deps.fallbackUserId()),
        rootId: mainRoot.rootId,
        model: agent.model,
        providerConfigId: agent.providerConfigId,
        systemPrompt: await buildSystemPrompt(deps.db, agent, {
          conversationPeerName: payload.conversationPeerName,
          mode: isConversation ? undefined : mode,
          paths: deps.paths,
          visionSupport: await modelSupportsVision(deps, agent.providerConfigId, agent.model),
        }),
        mode: isConversation ? "auto" : mode,
        excludeTools: excludeTools.length > 0 ? excludeTools : undefined,
        prePersisted: prePersisted || !payload.userMessage,
        suppressAutoMemory: payload.suppressAutoMemory,
        supportsVision: await modelSupportsVision(deps, agent.providerConfigId, agent.model),
      },
      payload.userMessage ?? [],
    );
  };
}
