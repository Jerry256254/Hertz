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
  /** 'generalist' in M1; architect/implementer/reviewer/tester roles land with M4 orchestration. */
  role: text("role").notNull().default("generalist"),
  providerConfigId: text("provider_config_id")
    .notNull()
    .references(() => providerConfigs.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt"),
  mode: text("mode", { enum: ["manual", "plan", "auto"] }).notNull().default("manual"),
  status: text("status", { enum: ["idle", "running", "error"] }).notNull().default("idle"),
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
  /** JSON-serialized {iv, authTag, ciphertext}, AES-256-GCM. Decrypted only in-process, never sent to clients. */
  encryptedKey: text("encrypted_key").notNull(),
  defaultModel: text("default_model"),
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
