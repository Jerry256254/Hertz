import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  /** Monthly AI spend cap in USD (null = unlimited). User-triggered runs past the cap are rejected with 402. */
  monthlyBudgetUsd: real("monthly_budget_usd"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Long-lived API tokens (htz_…) for external integrations — same identity as a
 * login session, but without expiry. The raw token is shown once at creation;
 * only its SHA-256 hash is stored.
 */
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  /** First characters of the raw token, so the owner can tell tokens apart. */
  prefixHint: text("prefix_hint").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});

/**
 * Public share links for chat sessions (grok.com/share style). Anyone with the
 * unguessable token can read a transcript snapshot; revoking deletes the row.
 */
export const sharedChats = sqliteTable("shared_chats", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
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

/**
 * Permanent folder mounts: user-approved host directories bind-mounted into
 * the agent's container and registered as extra PathGuard roots. V1 keeps
 * project_roots(main) as the source of truth for the project folder — mounts
 * are ADDITIONAL roots only (name 'main' is reserved, see mounts/mounts.ts).
 * agentId null = visible to the whole project, else scoped to one agent.
 */
export const mounts = sqliteTable("mounts", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  /** Agent-visible slug, unique per project — also the PathGuard root id. */
  name: text("name").notNull(),
  /** Absolute, realpath-canonicalised host directory. Immutable after creation. */
  hostPath: text("host_path").notNull(),
  /** User-written text shown to the agent in its "Your folders" prompt block. */
  purpose: text("purpose"),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  providerConfigId: text("provider_config_id")
    .notNull()
    .references(() => providerConfigs.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt"),
  /** One-line, human-facing summary of the outcome of the agent's most recent run — "Done.", "3 intros drafted…". */
  lastStatus: text("last_status"),
  /**
   * Where this agent's "computer" lives: "local" = host processes (original
   * behavior), "docker" = a dedicated container per agent (Grok-Bot-style own
   * machine). The container mounts the project root and the agent's personal
   * directory at their host paths, so tools work unchanged.
   */
  computerBackend: text("computer_backend", { enum: ["local", "docker"] }).notNull().default("docker"),
  /** Override of the default computer image for docker-backend agents. */
  computerImage: text("computer_image"),
  /** The agent's mascot emoji — its face everywhere in the UI (animated avatar). */
  mascot: text("mascot"),
  /**
   * Generative avatar spec (JSON: { version, kind, seed }) — the agent's unique
   * visual identity, minted at onboarding. Rendered via agents/avatar.ts as
   * standalone SVG or a data URL. NULL = render the deterministic fallback.
   */
  avatar: text("avatar"),
  /**
   * First-run onboarding (agent name + user name + avatar) completed at this
   * time. NULL = the agent must run the onboarding flow on its next turn.
   * Pre-existing agents are grandfathered as onboarded by migration.
   */
  onboardedAt: integer("onboarded_at", { mode: "timestamp_ms" }),
  /**
   * Proactive heartbeat interval in minutes (0 = off). When enabled, the agent
   * gets a periodic self-directed turn (OpenClaw-style heartbeat): it can check
   * its tools, continue stalled work, or message the user — or stay quiet.
   */
  heartbeatMinutes: integer("heartbeat_minutes").notNull().default(0),
  /** Standing instructions consulted at every heartbeat ("check my inbox and summarize anything urgent"). */
  heartbeatPrompt: text("heartbeat_prompt"),
  lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * An agent's own persistent notes, self-managed via the remember/forget tools and
 * injected into its system prompt on every call regardless of which session,
 * project, or meeting it's in — this is what makes memory survive across all of
 * them rather than living inside one session's message history.
 */
/**
 * An agent's layered persistent memory (agentmemory-style):
 * - kind "fact"       — deliberate, durable knowledge (the remember tool)
 * - kind "episode"    — auto-captured "was told X, did Y" per-run notes (low value)
 * - kind "preference" — user preferences the agent should always honor
 * Retrieval is scored by importance + recency + keyword relevance to the
 * current conversation, not just "last N rows", so the prompt carries what
 * actually matters.
 */
export const agentMemory = sqliteTable("agent_memory", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  note: text("note").notNull(),
  kind: text("kind", { enum: ["fact", "episode", "preference"] }).notNull().default("fact"),
  /** 1–5; episodes default 1, deliberate facts 3, user-stated preferences 4. */
  importance: integer("importance").notNull().default(2),
  /** Comma-separated lowercase keywords for relevance matching. */
  keywords: text("keywords"),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * L1 atoms — the bottom of the layered memory pyramid: single atomic facts
 * ("the deploy script lives at scripts/deploy.sh"), each traceable back to the
 * L0 conversation (session + message) it was distilled from and forward to the
 * L2 scenario that groups it. Replaces agent_memory for all new writes; legacy
 * rows are backfilled here once (see memory/recall.ts) and then left alone.
 */
export const agentMemoryAtoms = sqliteTable("agent_memory_atoms", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  /** One self-contained fact — no pronouns pointing outside the sentence. */
  text: text("text").notNull(),
  /** 1–5; auto-extracted 2, deliberate remember() 3, user-stated preferences 4+. */
  importance: integer("importance").notNull().default(2),
  /** Comma-separated lowercase keywords for BM25-style relevance matching. */
  keywords: text("keywords"),
  /** L2 scenario this atom belongs to (null = not yet clustered). */
  scenarioId: text("scenario_id").references((): any => agentMemoryScenarios.id, { onDelete: "set null" }),
  /** L0 provenance: the conversation turn this atom was distilled from. */
  sourceSessionId: text("source_session_id"),
  sourceMessageId: text("source_message_id"),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * L2 scenarios — mid-layer scene blocks aggregating related L1 atoms into
 * topics ("Friday sales reports", "home-server deploys"). The DB row is the
 * source of truth; a Markdown mirror lives at
 * agents/<agentId>/memory/scenarios/<slug>.md for white-box inspection.
 */
export const agentMemoryScenarios = sqliteTable("agent_memory_scenarios", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  /** URL-safe short identifier, unique per agent — also the mirror filename. */
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  /** 2–6 sentence dense summary of what this scenario covers. */
  summary: text("summary").notNull(),
  /** JSON array of L1 atom ids clustered into this scenario. */
  atomIdsJson: text("atom_ids_json").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  /** How the agent works in this session: "plan" = think/answer only, no tools; "auto" = full tools, may ask the user; "autonomous" = never asks, works until the goal is done. */
  mode: text("mode", { enum: ["plan", "auto", "autonomous"] }).notNull().default("autonomous"),
  status: text("status", { enum: ["active", "paused", "completed", "error", "archived", "awaiting_input"] })
    .notNull()
    .default("active"),
  /** Session-scoped state that isn't message history: current todo list, cached budget, etc. */
  metadata: text("metadata"),
  /** Set when this session was branched from another (M2). */
  parentSessionId: text("parent_session_id"),
  /** The one permanent user↔agent thread (main chat). Channel sessions and side chats are never flagged. */
  isMainChat: integer("is_main_chat", { mode: "boolean" }).notNull().default(false),
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
  /** Null = the human user; otherwise the agent that produced this message. */
  senderAgentId: text("sender_agent_id").references(() => agents.id, { onDelete: "cascade" }),
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
 * A persistent Linux shell belonging to one employee — a real long-lived bash
 * process, not a one-off spawn per tool call, so `cd`, exported env vars, and
 * background jobs survive across turns. An employee can have more than one
 * (named), and can grant another employee access to it (employeeShellGrants)
 * instead of everyone getting only their own isolated process.
 */
export const employeeShells = sqliteTable("employee_shells", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  ownerAgentId: text("owner_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const employeeShellGrants = sqliteTable("employee_shell_grants", {
  id: text("id").primaryKey(),
  shellId: text("shell_id")
    .notNull()
    .references(() => employeeShells.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One row per third-party service (google, slack) the CEO has registered an
 * OAuth app for — their own Client ID/Secret from that service's developer
 * console, since a self-hosted tool has no app of its own to broker through.
 * Needed both to build the consent-screen URL and, for Google, embedded into
 * the spawned MCP server's env so its OAuth2Client can auto-refresh.
 */
export const oauthApps = sqliteTable("oauth_apps", {
  id: text("id").primaryKey(),
  service: text("service", { enum: ["google", "slack", "mistral"] }).notNull().unique(),
  clientId: text("client_id").notNull(),
  encryptedClientSecret: text("encrypted_client_secret").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Grants a non-admin user access to one project. Admins bypass this entirely
 * (see every project); a "user"-role account only sees/acts on projects
 * they've been explicitly added to here.
 */
export const projectMembers = sqliteTable("project_members", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
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

/**
 * Durable work queue — every agent run (interactive chat, routine, delegated
 * task, heartbeat, channel message) is a row here before it executes, so work
 * survives process restarts instead of dying with an in-memory promise.
 * The worker (queue/job-queue.ts) claims due rows, runs them with bounded
 * concurrency, and retries failures with backoff; jobs found 'running' after a
 * crash are requeued at boot (boot reconciliation).
 */
export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  /** Handler discriminator: "agent_run" | "heartbeat" | ... registered in job-queue.ts. */
  type: text("type").notNull(),
  /** Handler-specific JSON payload. */
  payload: text("payload").notNull(),
  status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * A request by an agent for the user (CEO) to approve a sensitive action
 * before it happens ("Mám poslat tento e-mail?") — Grok-Bot-style human in
 * the loop. Creating one parks the agent's session in awaiting_input; the
 * decision (from the WebUI inbox, or later from a chat channel) resumes it.
 */
export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  /** One-line action summary shown in lists ("Send offer e-mail to Novák"). */
  summary: text("summary").notNull(),
  /** Longer context: what exactly would be done, to whom, with what content. */
  detail: text("detail"),
  /**
   * 'generic' = plain human-in-the-loop gate (agent describes, user decides);
   * 'host_access' = machine-readable one-shot host-filesystem op filed via
   * request_host_access (payload = HostAccessPayload JSON, result = HostAccessResult JSON).
   */
  kind: text("kind", { enum: ["generic", "host_access"] }).notNull().default("generic"),
  /** JSON-encoded HostAccessPayload for kind='host_access'; null otherwise. */
  payload: text("payload"),
  /** JSON-encoded HostAccessResult once a host_access op has been executed; null until then. */
  result: text("result"),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  decidedByUserId: text("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
});

/**
 * A chat channel connected to Hertz (Telegram bot, Discord bot) — the
 * Grok-Bot/OpenClaw "talk to your agent from your phone" surface. One config
 * per bot token; inbound messages route to a bound session (or the default
 * agent's new session), and the agent's replies are delivered back into the
 * same chat. Tokens are encrypted at rest like every other secret.
 */
export const channelConfigs = sqliteTable("channel_configs", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["telegram", "discord"] }).notNull(),
  label: text("label").notNull(),
  /** JSON-serialized {iv, authTag, ciphertext} of the bot token. */
  encryptedToken: text("encrypted_token").notNull(),
  /** The bot answers this agent by default when no binding exists yet. */
  defaultAgentId: text("default_agent_id")
    .references(() => agents.id, { onDelete: "set null" }),
  /**
   * Optional allowlist of external chat/channel ids (JSON array of strings).
   * Empty = only DMs with the bot's "owner" flag... practically: empty means
   * every chat that can see the bot may talk to it — prefer setting ids.
   */
  allowedChatsJson: text("allowed_chats_json"),
  /**
   * Optional allowlist of sender ids/usernames (JSON array of strings).
   * Empty = anyone in an allowed chat may talk; set to restrict to e.g.
   * ["123456789", "@boss"]. Matched against the platform sender id and label.
   */
  allowedSendersJson: text("allowed_senders_json"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Maps one external chat (telegram chat id / discord channel id) to a Hertz session thread. */
export const channelBindings = sqliteTable("channel_bindings", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channelConfigs.id, { onDelete: "cascade" }),
  /** External conversation identifier ("telegram:<chatId>" / "discord:<channelId>"). */
  externalChatId: text("external_chat_id").notNull(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Participants of a group chat (sessions.kind = "group"): multiple bots share
 * one thread the user can also write into. When the user posts, every
 * participant answers in turn (or only those @mentioned by name) — like a
 * messenger group where your bots work together and you watch it happen.
 */
/**
 * Per-user OAuth tokens for provider logins (e.g. "Sign in with Mistral") —
 * the refresh token is encrypted at rest; the access token lives in the
 * derived provider config's key field and is refreshed on demand.
 */
export const oauthTokens = sqliteTable("oauth_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  service: text("service", { enum: ["mistral"] }).notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
