import fs from "node:fs/promises";
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
import { users } from "./db/schema.js";

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
  const shellManager = new ShellManager(audit);

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

  const meetingOrchestrator = new MeetingOrchestrator({ db, providers, userId: fallbackUserId });

  const routineScheduler = new RoutineScheduler({
    db,
    paths,
    sandboxRegistry,
    agentLoop,
    fallbackUserId,
  });
  routineScheduler.start();

  return { paths, db, masterKey, audit, sandboxRegistry, agentLoop, meetingOrchestrator, mcpRegistry, routineScheduler, shellManager };
}
