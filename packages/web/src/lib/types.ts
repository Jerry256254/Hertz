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
  autoApprove: boolean;
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

export type AgentRole =
  | "manager"
  | "architect"
  | "implementer"
  | "reviewer"
  | "tester"
  | "researcher"
  | "generalist";

export const AGENT_ROLES: AgentRole[] = [
  "architect",
  "implementer",
  "reviewer",
  "tester",
  "researcher",
  "generalist",
];

export const ROLE_LABEL: Record<AgentRole, string> = {
  manager: "Manager",
  architect: "Architect",
  implementer: "Implementer",
  reviewer: "Reviewer",
  tester: "Tester",
  researcher: "Researcher",
  generalist: "Generalist",
};

export interface Agent {
  id: string;
  projectId: string;
  providerConfigId: string;
  name: string;
  role: AgentRole;
  model: string;
  mode: "manual" | "plan" | "auto";
  status: "idle" | "running" | "error" | "terminated";
  lastStatus?: string | null;
  jobDescription?: string | null;
  approvalStatus: "pending" | "approved" | "rejected";
  pendingTermination: boolean;
  createdAt: string;
  homeProjectName?: string;
}

export interface AgentMemoryNote {
  id: string;
  agentId: string;
  note: string;
  createdAt: string;
}

export interface HertzTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "done";
  createdAt: string;
  updatedAt: string;
  assignees: TaskAssignee[];
}

export interface TaskAssignee {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string | null;
  agentName: string;
  agentRole: AgentRole;
}

export interface HertzSession {
  id: string;
  agentId: string;
  peerAgentId?: string | null;
  projectId: string;
  title: string;
  kind: "chat" | "conversation";
  status: "active" | "completed" | "error" | "archived" | "paused";
  createdAt: string;
  updatedAt: string;
}

export interface Meeting {
  id: string;
  projectId: string;
  title: string;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
}

export interface MeetingMessage {
  id: string;
  meetingId: string;
  senderAgentId: string | null;
  content: ContentBlock[];
  createdAt: string;
}

export type MeetingEvent =
  | { type: "message"; message: MeetingMessage }
  | { type: "turn_started"; agentId: string; agentName: string }
  | { type: "error"; message: string }
  | { type: "done" };

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

export type AgentLoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; summary: string; isError?: boolean }
  | { type: "message_saved"; message: PersistedMessage }
  | { type: "status"; status: "running" | "idle" | "error" | "paused" }
  | { type: "error"; message: string }
  | { type: "done" };

/** One direct agent ↔ agent chat thread (a session with kind = "conversation"). */
export interface ConversationSummary {
  id: string;
  agentId: string;
  peerAgentId: string;
  projectId?: string;
  title: string;
  status: string;
  agentName: string;
  peerAgentName: string | null;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastSenderAgentId: string | null;
}

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
