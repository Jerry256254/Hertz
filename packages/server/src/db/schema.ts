import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Free-form JSON pointer to a kuclab.config.json override for this project, if any. */
  standardProfile: text("standard_profile"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * A project is N directories (multi-root). M1 only ever populates one row per
 * project, but the table exists now so M2 multi-root doesn't need a migration.
 */
export const projectRoots = sqliteTable("project_roots", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** Short slug used in tool-call addressing, e.g. "main". Unique per project. */
  rootId: text("root_id").notNull(),
  label: text("label").notNull(),
  absolutePath: text("absolute_path").notNull(),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role", {
    enum: ["manager", "architect", "implementer", "reviewer", "tester", "researcher", "generalist"],
  })
    .notNull()
    .default("generalist"),
  providerConfigId: text("provider_config_id")
    .notNull()
    .references(() => providerConfigs.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt"),
  mode: text("mode", { enum: ["manual", "plan", "auto"] }).notNull().default("manual"),
  status: text("status", { enum: ["idle", "running", "error"] }).notNull().default("idle"),
  /** One-line, human-facing summary of the outcome of this agent's most recent run — "Done.", "3 intros drafted…" — shown under their name in the sidebar. */
  lastStatus: text("last_status"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Additional projects an agent works on beyond its home project (agents.projectId).
 * Employees (not managers) can be attached to any number of projects so the same
 * identity — and the same memory below — carries across all of them.
 */
export const agentProjects = sqliteTable("agent_projects", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * An agent's own persistent notes, self-managed via the remember/forget tools and
 * injected into its system prompt on every call regardless of which session,
 * project, or meeting it's in — this is what makes memory survive across all of
 * them rather than living inside one session's message history.
 */
export const agentMemory = sqliteTable("agent_memory", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  note: text("note").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status", { enum: ["active", "completed", "error", "archived"] })
    .notNull()
    .default("active"),
  /** Session-scoped state that isn't message history: current todo list, cached budget, etc. */
  metadata: text("metadata"),
  /** Set when this session was branched from another (M2). */
  parentSessionId: text("parent_session_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["system", "user", "assistant", "tool"] }).notNull(),
  /** JSON-serialized ContentBlock[] (text/image/tool_use/tool_result) from @kuclab-hertz/providers. */
  content: text("content").notNull(),
  /** JSON-serialized raw tool call/result pairs, kept alongside content for UI rendering. */
  toolCalls: text("tool_calls"),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  cachedTokensIn: integer("cached_tokens_in").notNull().default(0),
  cost: real("cost").notNull().default(0),
  purpose: text("purpose", {
    enum: ["agent_turn", "summarization", "routing", "title_generation"],
  })
    .notNull()
    .default("agent_turn"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const providerConfigs = sqliteTable("provider_configs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["anthropic", "openai", "google", "openai-compatible"] }).notNull(),
  label: text("label").notNull(),
  baseUrl: text("base_url"),
  /** JSON-serialized {iv, authTag, ciphertext}, AES-256-GCM. The pool's first/primary key; decrypted only in-process, never sent to clients. */
  encryptedKey: text("encrypted_key").notNull(),
  defaultModel: text("default_model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Extra keys beyond provider_configs.encrypted_key, for accounts that hold several
 * API keys (e.g. multiple billing accounts) and want automatic failover: when a
 * call hits a rate limit, the next key in the pool is tried before giving up.
 */
export const providerConfigKeys = sqliteTable("provider_config_keys", {
  id: text("id").primaryKey(),
  providerConfigId: text("provider_config_id")
    .notNull()
    .references(() => providerConfigs.id, { onDelete: "cascade" }),
  encryptedKey: text("encrypted_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const usageRecords = sqliteTable("usage_records", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  purpose: text("purpose", {
    enum: ["agent_turn", "summarization", "routing", "title_generation"],
  })
    .notNull()
    .default("agent_turn"),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  cachedTokensIn: integer("cached_tokens_in").notNull().default(0),
  cost: real("cost").notNull().default(0),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type", { enum: ["user", "agent"] }).notNull(),
  sessionId: text("session_id"),
  projectId: text("project_id"),
  action: text("action").notNull(),
  target: text("target"),
  targetType: text("target_type"),
  result: text("result", { enum: ["allowed", "denied", "error"] }).notNull(),
  detail: text("detail"),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * A meeting is a shared, multi-agent conversation the user convenes explicitly —
 * distinct from a Session (one agent, one thread). Each participant takes a
 * conversational turn in sequence when the user posts; the whole transcript is
 * visible to the user for oversight, per the product requirement that the human
 * can see agent-to-agent communication, not just delegate blindly to it.
 */
export const meetings = sqliteTable("meetings", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status", { enum: ["active", "ended"] }).notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const meetingParticipants = sqliteTable("meeting_participants", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
});

export const meetingMessages = sqliteTable("meeting_messages", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  /** Null = the human user spoke; otherwise the id of the agent whose turn produced this message. */
  senderAgentId: text("sender_agent_id"),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * A task is work the user hands to a chosen subset of the team at once — not
 * everyone, only whoever is picked. Creating one starts a real session per
 * assignee, seeded with the task brief, so each assignee actually goes to work
 * rather than just being "notified."
 */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: text("status", { enum: ["open", "in_progress", "done"] }).notNull().default("open"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const taskAssignees = sqliteTable("task_assignees", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  /** The session where this assignee's work on the task actually happens. */
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
});

/**
 * An MCP server an agent can call tools on, in addition to the built-in fs/shell/
 * web/org/memory toolset. Global (agentId null) servers are available to every
 * agent; scoped ones only to the named agent. Sensitive fields (env vars for
 * stdio, headers for sse — API keys typically live in both) are encrypted with
 * the same AES-256-GCM scheme as provider_configs.encrypted_key, never plaintext.
 */
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  /** Null = available to every agent; otherwise scoped to this one agent. */
  agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  transport: text("transport", { enum: ["stdio", "sse"] }).notNull(),
  /** stdio only. */
  command: text("command"),
  argsJson: text("args_json"),
  /** JSON-serialized {iv, authTag, ciphertext} of a {[key]: value} env map (stdio) or header map (sse). */
  encryptedEnv: text("encrypted_env"),
  /** sse only. */
  url: text("url"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Recurring work: same idea as a Task, but re-briefed on a schedule instead of
 * once. The scheduler (routines/routine-scheduler.ts) reads nextRunAt from here
 * rather than keeping timers in memory, so a server restart doesn't drop a run.
 */
export const routines = sqliteTable("routines", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  taskTemplate: text("task_template").notNull(),
  /** "once" | "daily" | "weekly" | a raw 5-field cron expression. */
  schedule: text("schedule").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
  nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Direct, async messages between employees (or an employee broadcasting to a
 * few colleagues) — distinct from a Meeting (user-convened, sequential turns)
 * and from assign_task (manager delegating and blocking on the result). Always
 * visible to the user for oversight, same principle as meetings.
 */
export const employeeMessages = sqliteTable("employee_messages", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  fromAgentId: text("from_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  toAgentId: text("to_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessionTokens = sqliteTable("session_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** SHA-256 hex of the opaque bearer token — the raw token is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
});
