export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface User {
  id: string;
  email: string;
  role: "admin" | "user";
}

export interface ProjectRoot {
  id: string;
  rootId: string;
  label: string;
  absolutePath: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  roots: ProjectRoot[];
}

export interface ProviderConfig {
  id: string;
  provider: "anthropic" | "openai" | "google" | "openai-compatible";
  label: string;
  baseUrl?: string;
  defaultModel?: string;
  keyHint: string;
  keyCount: number;
  createdAt: string;
}

export interface ProviderKey {
  id: string;
  keyHint: string;
  createdAt: string;
}

export type PresetCategory = "frontier" | "aggregator" | "local";

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderConfig["provider"];
  category: PresetCategory;
  baseUrl?: string;
  hint: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow?: number;
}

/** The single agent (GET /api/agent returns the row plus `isolated`). */
export interface Agent {
  id: string;
  projectId: string;
  name: string;
  providerConfigId: string;
  model: string;
  systemPrompt: string | null;
  lastStatus: string | null;
  computerBackend: "local" | "docker";
  computerImage: string | null;
  mascot: string | null;
  heartbeatMinutes: number;
  heartbeatPrompt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  isolated: boolean;
}

export interface AgentMemoryNote {
  id: string;
  agentId: string;
  note: string;
  createdAt: string;
}

/** L1 atom in the agent's layered memory. */
export interface AgentMemoryAtom {
  id: string;
  agentId: string;
  text: string;
  importance: number;
  scenarioId: string | null;
  sourceSessionId: string | null;
  createdAt: string;
}

/** L2 scenario block in the agent's layered memory. */
export interface AgentMemoryScenario {
  id: string;
  agentId: string;
  slug: string;
  title: string;
  summary: string;
  updatedAt: string;
}

export interface AgentLayeredMemory {
  notes: AgentMemoryNote[];
  persona: string;
  scenarios: AgentMemoryScenario[];
  atoms: AgentMemoryAtom[];
}

export interface HertzSession {
  id: string;
  agentId: string;
  peerAgentId?: string | null;
  projectId: string;
  title: string;
  kind: "chat" | "conversation" | "group";
  mode?: "plan" | "auto" | "autonomous" | null;
  status: "active" | "completed" | "error" | "archived" | "paused" | "awaiting_input";
  createdAt: string;
  updatedAt: string;
}

export interface SessionListItem {
  id: string;
  agentId: string;
  projectId: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  agentName: string;
  projectName: string;
}

export interface PersistedMessage {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
  /** Agent that wrote this message (null = the human user). */
  senderAgentId?: string | null;
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn: number;
  cost: number;
  purpose: string;
  createdAt: string;
}

export interface Budget {
  used: number;
  cachedPortion: number;
  limit: number;
  percent: number;
}

export interface UsageRecord {
  id: string;
  sessionId?: string;
  provider: string;
  model: string;
  purpose: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn: number;
  cost: number;
  at: string;
}

export interface SubagentInfo {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "interrupted";
  progress?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type AgentLoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; summary: string; isError?: boolean }
  | { type: "message_saved"; message: PersistedMessage }
  | { type: "status"; status: "running" | "idle" | "error" | "paused" }
  | { type: "awaiting_input"; question: string }
  | { type: "subagents"; subagents: SubagentInfo[] }
  | { type: "error"; message: string }
  | { type: "done" };

export interface Routine {
  id: string;
  projectId: string;
  agentId: string;
  agentName: string;
  title: string;
  taskTemplate: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface EmployeeShell {
  id: string;
  projectId: string;
  ownerAgentId: string;
  name: string;
  owned: boolean;
  ownerName?: string;
  sharedWith: string[];
  alive: boolean;
  createdAt: string;
}

export interface McpServer {
  id: string;
  agentId: string | null;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  args: string[];
  url: string | null;
  hasSecret: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface McpToolsForAgent {
  serverId: string;
  serverName: string;
  tools: string[];
  error?: string;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

/** Permanent host-folder mount visible to the agent's computer. */
export interface Mount {
  id: string;
  projectId: string;
  agentId: string | null;
  name: string;
  hostPath: string;
  purpose: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface MountList {
  mounts: Mount[];
  builtIn: { name: string; hostPath: string; purpose: string } | null;
}

export type HostAccessOp = "read" | "rewrite" | "create" | "delete";

export interface HostAccessPayload {
  op: HostAccessOp;
  hostPath: string;
  content?: string;
  reason: string;
}

export interface HostAccessResult {
  ok: boolean;
  output?: string;
  bytes?: number;
  error?: string;
}

export interface ApprovalItem {
  id: string;
  projectId: string;
  agentId: string;
  sessionId: string;
  summary: string;
  detail: string | null;
  kind: "generic" | "host_access";
  payload: string | null;
  result: string | null;
  status: "pending" | "approved" | "rejected";
  decidedByUserId: string | null;
  createdAt: string;
  decidedAt: string | null;
  agentName: string;
  projectName: string;
  sessionTitle: string;
  decidedByEmail: string | null;
}

export interface ChannelConfig {
  id: string;
  kind: "telegram" | "discord";
  label: string;
  tokenHint: string;
  defaultAgentId: string | null;
  allowedChats: string[];
  allowedSenders: string[];
  enabled: boolean;
  running: boolean;
  botLabel: string | null;
  createdAt: string;
}

export interface ChannelBinding {
  id: string;
  channelId: string;
  externalChatId: string;
  sessionId: string;
  projectId: string | null;
  sessionTitle: string | null;
  createdAt: string;
}

/** Credential vault (Trezor) — metadata only; the secret is never sent to the client. */
export interface VaultCredential {
  id: string;
  service: string;
  label: string;
  username: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
