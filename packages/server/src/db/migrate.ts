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
  role TEXT NOT NULL DEFAULT 'generalist',
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  system_prompt TEXT,
  mode TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'idle',
  last_status TEXT,
  job_description TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);

CREATE TABLE IF NOT EXISTS agent_projects (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_projects_agent ON agent_projects(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_projects_project ON agent_projects(project_id);

CREATE TABLE IF NOT EXISTS agent_memory (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings(project_id);

CREATE TABLE IF NOT EXISTS meeting_participants (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting ON meeting_participants(meeting_id);

CREATE TABLE IF NOT EXISTS meeting_messages (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  sender_agent_id TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_messages_meeting ON meeting_messages(meeting_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS task_assignees (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);

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

CREATE TABLE IF NOT EXISTS employee_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  to_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employee_messages_project ON employee_messages(project_id);
CREATE INDEX IF NOT EXISTS idx_employee_messages_to ON employee_messages(to_agent_id);

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

CREATE TABLE IF NOT EXISTS session_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
`;

/**
 * CREATE TABLE IF NOT EXISTS handles brand-new tables, but not new columns on a
 * table that already exists from a previous install — those need an explicit
 * ALTER TABLE, guarded against re-running on a DB that already has the column.
 */
const COLUMN_MIGRATIONS: string[] = [
  "ALTER TABLE agents ADD COLUMN last_status TEXT",
  "ALTER TABLE agents ADD COLUMN job_description TEXT",
  "ALTER TABLE agents ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'",
];

export async function runMigrations(client: Client): Promise<void> {
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
