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
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow?: number;
}

export interface Agent {
  id: string;
  projectId: string;
  providerConfigId: string;
  name: string;
  role: string;
  model: string;
  mode: "manual" | "plan" | "auto";
  status: "idle" | "running" | "error";
  createdAt: string;
}

export interface HertzSession {
  id: string;
  agentId: string;
  projectId: string;
  title: string;
  status: "active" | "completed" | "error" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface PersistedMessage {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
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
  | { type: "status"; status: "running" | "idle" | "error" }
  | { type: "error"; message: string }
  | { type: "done" };

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}
