export type ContentBlock =
  | { type: "text"; text: string; cache?: boolean }
  | { type: "image"; mimeType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  /** Large, stable instructions — first candidate for prompt caching. */
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /**
   * How many leading messages (in addition to `system`) are stable across turns
   * in this session and therefore cache-eligible. Set by core's cache-planner,
   * consumed by adapters whose cacheStrategy is 'anthropic-breakpoints'.
   */
  cachePrefixMessageCount?: number;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type StopReason = "end_turn" | "max_tokens" | "tool_use" | "error";

export interface ChatResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: UsageInfo;
  model: string;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; inputDelta: string }
  | { type: "tool_use_end"; id: string }
  | { type: "message_end"; stopReason: StopReason; usage: UsageInfo }
  | { type: "error"; message: string };

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  currency: "USD";
}

export type CacheStrategy = "anthropic-breakpoints" | "openai-automatic" | "none";

export interface ProviderCredentials {
  apiKey: string;
  /** Only used by the openai-compatible adapter (Ollama, OpenRouter, vLLM, LM Studio, ...). */
  baseUrl?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly supportsCaching: boolean;
  readonly cacheStrategy: CacheStrategy;
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  countTokens(req: ChatRequest): Promise<number>;
  pricing(model: string): ModelPricing | undefined;
}

export class ProviderError extends Error {
  readonly status?: number;
  readonly providerId: string;

  constructor(providerId: string, message: string, status?: number) {
    super(`[${providerId}] ${message}`);
    this.name = "ProviderError";
    this.providerId = providerId;
    this.status = status;
  }
}
