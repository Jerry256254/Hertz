import type { ProviderAdapter, ContentBlock } from "@kuclab-hertz/providers";
import type { ToolContext, ToolResult } from "@kuclab-hertz/tools";
import type { ToolDefinition } from "@kuclab-hertz/providers";

export interface ProviderPort {
  /** Resolves a stored ProviderConfig id (decrypting its key server-side) into a ready-to-use adapter. */
  getAdapter(providerConfigId: string): Promise<ProviderAdapter>;
}

export interface ToolPort {
  /** Some tools (e.g. hire_employee) are only offered to agents in specific roles — hence per-agent, not static. */
  listDefinitions(agentId: string): Promise<ToolDefinition[]>;
  run(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePurpose = "agent_turn" | "summarization" | "routing" | "title_generation";

export interface PersistedMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: ContentBlock[];
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn: number;
  cost: number;
  purpose: MessagePurpose;
  createdAt: Date;
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
    status: "active" | "completed" | "error" | "archived",
  ): Promise<void>;
  getSessionMetadata(sessionId: string): Promise<Record<string, unknown> | undefined>;
  setSessionMetadata(sessionId: string, metadata: Record<string, unknown>): Promise<void>;
  recordUsage(rec: UsageRecordInput): Promise<void>;
  /** One-line, human-facing summary of an agent's most recent run ("Done.", "3 intros drafted…") — shown in the sidebar. */
  updateAgentLastStatus(agentId: string, status: string): Promise<void>;
  /** Appends one auto-captured memory note for an agent — see agent-loop.ts's per-turn auto-save. */
  appendMemoryNote(agentId: string, note: string): Promise<void>;
}

export type { ToolContext } from "@kuclab-hertz/tools";
