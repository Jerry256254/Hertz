import type { ProviderAdapter, ContentBlock, ModelResolution } from "@kuclab-hertz/providers";
import type { ToolContext, ToolResult } from "@kuclab-hertz/tools";
import type { ToolDefinition } from "@kuclab-hertz/providers";

export interface ProviderPort {
  /** Resolves a stored ProviderConfig id (decrypting its key server-side) into a ready-to-use adapter. */
  getAdapter(providerConfigId: string): Promise<ProviderAdapter>;
  /**
   * Validates/normalizes a model id against what the provider actually serves,
   * before any call goes out: known aliases are mapped, otherwise the
   * provider's configured default (or first supported) model is used instead
   * of failing at stream time. Optional — when absent the requested id is used
   * as-is. Must never throw: on any failure the requested id passes through.
   */
  resolveModel?(providerConfigId: string, requestedModel: string): Promise<ModelResolution>;
}

export interface ToolPort {
  /** Some tools (e.g. hire_employee) are only offered to agents in specific roles — hence per-agent, not static. */
  listDefinitions(agentId: string): Promise<ToolDefinition[]>;
  run(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePurpose = "agent_turn" | "summarization" | "routing" | "title_generation";

/**
 * A file the agent delivered to the user with the send_file tool.
 * Served for download by id (never by path) — see server attachments route.
 */
export interface FileAttachmentInfo {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  caption?: string | null;
  createdAt: Date;
}

/** FileAttachmentInfo plus the guard-resolved server path (server-side only, never sent to clients). */
export interface FileAttachment extends FileAttachmentInfo {
  absolutePath: string;
}

export interface PersistedMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: ContentBlock[];
  /** Null/undefined = the human user; otherwise the id of the agent who produced this message (both sides of an agent-to-agent conversation are role user/assistant with a real sender). */
  senderAgentId?: string | null;
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn: number;
  cost: number;
  purpose: MessagePurpose;
  createdAt: Date;
  /** Files the agent attached to this message via the send_file tool. */
  attachments?: FileAttachmentInfo[];
}

export interface UsageRecordInput {
  sessionId?: string;
  userId: string;
  provider: string;
  model: string;
  purpose: MessagePurpose;
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn: number;
  cost: number;
}

export interface PersistencePort {
  appendMessage(msg: Omit<PersistedMessage, "id" | "createdAt">): Promise<PersistedMessage>;
  listMessages(sessionId: string): Promise<PersistedMessage[]>;
  updateSessionStatus(
    sessionId: string,
    status: "active" | "paused" | "completed" | "error" | "archived" | "awaiting_input",
  ): Promise<void>;
  getSessionMetadata(sessionId: string): Promise<Record<string, unknown> | undefined>;
  setSessionMetadata(sessionId: string, metadata: Record<string, unknown>): Promise<void>;
  recordUsage(rec: UsageRecordInput): Promise<void>;
  /** One-line, human-facing summary of an agent's most recent run ("Done.", "3 intros drafted…") — shown in the sidebar. */
  updateAgentLastStatus(agentId: string, status: string): Promise<void>;
  /** Appends one memory entry for an agent — see agent-loop.ts's auto-episodes and the remember tool's facts. */
  appendMemoryNote(
    agentId: string,
    note: string,
    meta?: { kind?: "fact" | "episode" | "preference"; importance?: number; keywords?: string },
  ): Promise<void>;
}

export type { ToolContext } from "@kuclab-hertz/tools";
