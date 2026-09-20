import type { Client } from "@libsql/client";

/**
 * Hand-written, idempotent (CREATE TABLE IF NOT EXISTS) bootstrap SQL mirroring
 * schema.ts. Chosen over drizzle-kit's generated migration files for M1 because
 * the CLI ships as a single installed npm package — bundling and discovering a
 * migrations/ directory at runtime from an arbitrary global-install location adds
 * moving parts for no benefit while there is no production data to migrate yet.
 * Revisit with drizzle-kit generated migrations once schema changes need to
 * preserve existing users' data across upgrades (M2+).
 */
const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  standard_profile TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_roots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  label TEXT NOT NULL,
  absolute_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_roots_project ON project_roots(project_id);

CREATE TABLE IF NOT EXISTS mounts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  host_path TEXT NOT NULL,
  purpose TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mounts_project ON mounts(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mounts_project_name ON mounts(project_id, name);
CREATE INDEX IF NOT EXISTS idx_mounts_agent ON mounts(agent_id);

CREATE TABLE IF NOT EXISTS provider_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  encrypted_key TEXT NOT NULL,
  default_model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_configs_user ON provider_configs(user_id);

CREATE TABLE IF NOT EXISTS provider_config_keys (
  id TEXT PRIMARY KEY,
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_config_keys_config ON provider_config_keys(provider_config_id);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  system_prompt TEXT,
  last_status TEXT,
  computer_backend TEXT NOT NULL DEFAULT 'docker',
  computer_image TEXT,
  mascot TEXT,
  heartbeat_minutes INTEGER NOT NULL DEFAULT 0,
  heartbeat_prompt TEXT,
  last_heartbeat_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);

CREATE TABLE IF NOT EXISTS agent_memory (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  importance INTEGER NOT NULL DEFAULT 2,
  keywords TEXT,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id);

CREATE TABLE IF NOT EXISTS agent_memory_atoms (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 2,
  keywords TEXT,
  scenario_id TEXT REFERENCES agent_memory_scenarios(id) ON DELETE SET NULL,
  source_session_id TEXT,
  source_message_id TEXT,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_atoms_agent ON agent_memory_atoms(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_atoms_scenario ON agent_memory_atoms(scenario_id);

CREATE TABLE IF NOT EXISTS agent_memory_scenarios (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  atom_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_scenarios_agent ON agent_memory_scenarios(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_scenarios_agent_slug ON agent_memory_scenarios(agent_id, slug);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'autonomous',
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT,
  parent_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sender_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  tool_calls TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cached_tokens_in INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT 'agent_turn',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'agent_turn',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cached_tokens_in INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_records_user ON usage_records(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_session ON usage_records(session_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  target_type TEXT,
  result TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  command TEXT,
  args_json TEXT,
  encrypted_env TEXT,
  url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_agent ON mcp_servers(agent_id);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  task_template TEXT NOT NULL,
  schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routines_project ON routines(project_id);

CREATE TABLE IF NOT EXISTS employee_shells (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employee_shells_owner ON employee_shells(owner_agent_id);

CREATE TABLE IF NOT EXISTS employee_shell_grants (
  id TEXT PRIMARY KEY,
  shell_id TEXT NOT NULL REFERENCES employee_shells(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employee_shell_grants_shell ON employee_shell_grants(shell_id);
CREATE INDEX IF NOT EXISTS idx_employee_shell_grants_agent ON employee_shell_grants(agent_id);

CREATE TABLE IF NOT EXISTS oauth_apps (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  encrypted_client_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

CREATE TABLE IF NOT EXISTS session_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  detail TEXT,
  kind TEXT NOT NULL DEFAULT 'generic',
  payload TEXT,
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_configs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  default_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  allowed_chats_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channel_configs(id) ON DELETE CASCADE,
  external_chat_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_bindings_chat ON channel_bindings(channel_id, external_chat_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix_hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS shared_chats (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
`;

/**
 * CREATE TABLE IF NOT EXISTS handles brand-new tables, but not new columns on a
 * table that already exists from a previous install — those need an explicit
 * ALTER TABLE, guarded against re-running on a DB that already has the column.
 */
const COLUMN_MIGRATIONS: string[] = [
  "ALTER TABLE agents ADD COLUMN last_status TEXT",
  "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto'",
  "ALTER TABLE messages ADD COLUMN sender_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE",
  "ALTER TABLE agents ADD COLUMN computer_backend TEXT NOT NULL DEFAULT 'docker'",
  "ALTER TABLE agents ADD COLUMN computer_image TEXT",
  "ALTER TABLE agents ADD COLUMN heartbeat_minutes INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agents ADD COLUMN heartbeat_prompt TEXT",
  "ALTER TABLE agents ADD COLUMN last_heartbeat_at INTEGER",
  "ALTER TABLE agent_memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'",
  "ALTER TABLE agent_memory ADD COLUMN importance INTEGER NOT NULL DEFAULT 2",
  "ALTER TABLE agent_memory ADD COLUMN keywords TEXT",
  "ALTER TABLE agent_memory ADD COLUMN last_used_at INTEGER",
  "ALTER TABLE agents ADD COLUMN mascot TEXT",
  "ALTER TABLE users ADD COLUMN monthly_budget_usd REAL",
  "ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'generic'",
  "ALTER TABLE approvals ADD COLUMN payload TEXT",
  "ALTER TABLE approvals ADD COLUMN result TEXT",
];

/**
 * Single-agent pivot: the org layer (meetings, tasks, agent↔agent messaging,
 * group sessions) is gone. Existing installs keep users/projects/keys/chats,
 * but the org tables and columns are dropped. Runs before bootstrap so a
 * fresh CREATE never sees the old shape.
 */
const DROP_TABLES: string[] = [
  "meeting_messages",
  "meeting_participants",
  "meetings",
  "task_assignees",
  "tasks",
  "employee_messages",
  "session_participants",
  "agent_projects",
];

const DROP_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "agents", column: "role" },
  { table: "agents", column: "mode" },
  { table: "agents", column: "status" },
  { table: "agents", column: "job_description" },
  { table: "agents", column: "approval_status" },
  { table: "agents", column: "pending_termination" },
  { table: "sessions", column: "kind" },
  { table: "sessions", column: "peer_agent_id" },
  { table: "projects", column: "auto_approve" },
];

const DROP_INDEXES: string[] = [
  "idx_sessions_conversation_pair",
];

export async function runMigrations(client: Client): Promise<void> {
  // Grandfathered local-backend agents keep their value (the API can no longer
  // select 'local', but existing rows keep working with an "unisolated" label).
  for (const table of DROP_TABLES) {
    await client.execute(`DROP TABLE IF EXISTS ${table}`);
  }
  for (const index of DROP_INDEXES) {
    await client.execute(`DROP INDEX IF EXISTS ${index}`);
  }
  for (const { table, column } of DROP_COLUMNS) {
    try {
      await client.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch (err) {
      // Missing table/column on fresh DBs — only real failures propagate.
      if (!/no such (table|column)/i.test((err as Error).message)) throw err;
    }
  }
  const statements = BOOTSTRAP_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await client.execute(statement);
  }
  for (const ddl of COLUMN_MIGRATIONS) {
    try {
      await client.execute(ddl);
    } catch (err) {
      if (!/duplicate column name/i.test((err as Error).message)) throw err;
    }
  }
}
