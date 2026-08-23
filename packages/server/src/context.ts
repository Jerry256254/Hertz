import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { AgentLoopManager } from "@kuclab-hertz/core";
import type { AuditSink } from "@kuclab-hertz/sandbox";
import { openDatabase, type Database } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { resolveHertzPaths, type HertzPaths } from "./paths.js";
import { loadOrCreateMasterKey } from "./secrets/master-key.js";
import { createPersistenceAdapter } from "./persistence/persistence-adapter.js";
import { createProviderRegistry } from "./providers/provider-registry.js";
import { createToolPort } from "./tools/tool-port.js";
import { SandboxRegistry } from "./sandbox/sandbox-registry.js";
import { createDbAuditSink } from "./audit/db-audit-sink.js";
import { MeetingOrchestrator } from "./meetings/meeting-orchestrator.js";
import { McpRegistry } from "./mcp/mcp-registry.js";
import { RoutineScheduler } from "./routines/routine-scheduler.js";
import { ShellManager } from "./shells/shell-manager.js";
import { JobQueue } from "./queue/job-queue.js";
import { createAgentRunHandler, type RunJobsDeps } from "./runtime/run-jobs.js";
import { reconcileOnBoot } from "./runtime/reconcile.js";
import { ComputerManager } from "./computer/computer-manager.js";
import { HeartbeatScheduler } from "./heartbeats/heartbeat-scheduler.js";
import { ChannelManager } from "./channels/channel-manager.js";
import { decryptSecret } from "./secrets/key-encryption.js";
import { agents, users } from "./db/schema.js";

export interface AppContext {
  paths: HertzPaths;
  db: Database;
  masterKey: Buffer;
  audit: AuditSink;
  sandboxRegistry: SandboxRegistry;
  agentLoop: AgentLoopManager;
  meetingOrchestrator: MeetingOrchestrator;
  mcpRegistry: McpRegistry;
  routineScheduler: RoutineScheduler;
  shellManager: ShellManager;
  queue: JobQueue;
  computer: ComputerManager;
  heartbeatScheduler: HeartbeatScheduler;
  channelManager: ChannelManager;
}

export async function createAppContext(dataDir?: string): Promise<AppContext> {
  const paths = resolveHertzPaths(dataDir);
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.projectsDir, { recursive: true });
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  const { client, db } = openDatabase(paths.dbPath);
  await runMigrations(client);

  const masterKey = await loadOrCreateMasterKey(paths);
  const audit = createDbAuditSink(db, paths);
  const sandboxRegistry = new SandboxRegistry(audit, paths);
  const persistence = createPersistenceAdapter(db);
  const providers = createProviderRegistry(db, masterKey);
  const mcpRegistry = new McpRegistry(db, masterKey);
  const computer = new ComputerManager(audit);
  const shellPrefixResolver = async (ownerAgentId: string, cwd: string): Promise<string[] | undefined> => {
    const rows = await db.select({ backend: agents.computerBackend }).from(agents).where(eq(agents.id, ownerAgentId)).limit(1);
    if (rows[0]?.backend !== "docker") return undefined;
    return ["docker", "exec", "-w", cwd, "-i", computer.containerName(ownerAgentId)];
  };
  const shellManager = new ShellManager(audit, shellPrefixResolver);
  const queue = new JobQueue(db);

  // ToolPort's org tools (assign_task) need to trigger the agent loop, but the
  // agent loop needs a ToolPort to be constructed — break the cycle with a lazy
  // getter, filled in once agentLoop exists below.
  let agentLoopRef: AgentLoopManager | undefined;
  const tools = createToolPort({
    db,
    paths,
    sandboxRegistry,
    mcpRegistry,
    shellManager,
    providers,
    queue,
    persistence,
    getAgentLoop: () => {
      if (!agentLoopRef) throw new Error("AgentLoopManager not initialized yet");
      return agentLoopRef;
    },
  });

  const agentLoop = new AgentLoopManager({
    providers,
    tools,
    persistence,
    sandbox: (sessionId) => sandboxRegistry.get(sessionId),
  });
  agentLoopRef = agentLoop;

  const fallbackUserId = async () => {
    const rows = await db.select({ id: users.id }).from(users).limit(1);
    return rows[0]?.id ?? "";
  };

  const runJobsDeps: RunJobsDeps = {
    db,
    paths,
    sandboxRegistry,
    persistence,
    agentLoop,
    queue,
    computer,
    fallbackUserId,
  };
  queue.register("agent_run", createAgentRunHandler(runJobsDeps));

  // Durable runtime: recover what the previous process left behind, then let
  // the queue drive everything. After this point a crash costs at most the
  // current turn of each session — never the intent to work.
  const reconciliation = await reconcileOnBoot(runJobsDeps);
  if (reconciliation.requeuedJobs > 0 || reconciliation.resumedSessions > 0) {
    console.log(
      `[hertz] recovered after restart: ${reconciliation.resumedSessions} session(s) resumed, ${reconciliation.requeuedJobs} job(s) requeued`,
    );
  }
  queue.start();

  const meetingOrchestrator = new MeetingOrchestrator({ db, providers, userId: fallbackUserId });

  const routineScheduler = new RoutineScheduler({
    db,
    queue,
    fallbackUserId,
  });
  routineScheduler.start();

  const heartbeatScheduler = new HeartbeatScheduler({ db, queue });
  heartbeatScheduler.start();

  const channelManager = new ChannelManager({
    db,
    queue,
    masterKey,
    decrypt: decryptSecret,
    fallbackUserId,
  });
  await channelManager.start();

  return {
    paths,
    db,
    masterKey,
    audit,
    sandboxRegistry,
    agentLoop,
    meetingOrchestrator,
    mcpRegistry,
    routineScheduler,
    shellManager,
    queue,
    computer,
    heartbeatScheduler,
    channelManager,
  };
}
