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

export interface AppContext {
  paths: HertzPaths;
  db: Database;
  masterKey: Buffer;
  audit: AuditSink;
  sandboxRegistry: SandboxRegistry;
  agentLoop: AgentLoopManager;
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
  const tools = createToolPort();

  const agentLoop = new AgentLoopManager({
    providers,
    tools,
    persistence,
    sandbox: (sessionId) => sandboxRegistry.get(sessionId),
  });

  return { paths, db, masterKey, audit, sandboxRegistry, agentLoop };
}
