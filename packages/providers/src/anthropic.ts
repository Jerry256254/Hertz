import { parseSSEStream } from "./sse.js";
import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ModelInfo,
  ModelPricing,
  ProviderAdapter,
  ProviderCredentials,
  StopReason,
  StreamEvent,
  UsageInfo,
} from "./types.js";
import { ProviderError } from "./types.js";
import pricingTable from "./pricing/anthropic.json" with { type: "json" };

const API_BASE = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";

function toAnthropicContent(blocks: ContentBlock[], cacheEligible: boolean) {
  return blocks.map((block, i) => {
    const isLast = i === blocks.length - 1;
    const cacheControl = cacheEligible && isLast ? { cache_control: { type: "ephemeral" } } : {};
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text, ...cacheControl };
      case "image":
        return {
          type: "image",
          source: { type: "base64", media_type: block.mimeType, data: block.data },
        };
      case "tool_use":
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError,
        };
    }
  });
}

function fromAnthropicStopReason(reason: string | null): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end_turn";
}

function buildBody(req: ChatRequest) {
  const cachePrefix = req.cachePrefixMessageCount ?? 0;
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    temperature: req.temperature,
    system: req.system
      ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
      : undefined,
    messages: req.messages.map((m, i) => ({
      role: m.role,
      content: toAnthropicContent(m.content, i < cachePrefix),
    })),
    tools: req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    })),
  };
}

function extractUsage(usage: any): UsageInfo {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
  };
}

export function createAnthropicAdapter(creds: ProviderCredentials): ProviderAdapter {
  const headers = {
    "x-api-key": creds.apiKey,
    "anthropic-version": API_VERSION,
    "content-type": "application/json",
  };

  async function listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${API_BASE}/models?limit=1000`, { headers });
    if (!res.ok) {
      throw new ProviderError("anthropic", `listModels failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as { data: Array<{ id: string; display_name?: string }> };
    return body.data.map((m) => ({
      id: m.id,
      displayName: m.display_name ?? m.id,
      supportsTools: true,
      supportsVision: true,
    }));
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${API_BASE}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(req)),
    });
    if (!res.ok) {
      throw new ProviderError("anthropic", `chat failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as any;
    const content: ContentBlock[] = body.content.map((b: any) =>
      b.type === "text"
        ? { type: "text", text: b.text }
        : { type: "tool_use", id: b.id, name: b.name, input: b.input },
    );
    return {
      content,
      stopReason: fromAnthropicStopReason(body.stop_reason),
      usage: extractUsage(body.usage),
      model: body.model,
    };
  }

  async function* stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const res = await fetch(`${API_BASE}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...buildBody(req), stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new ProviderError("anthropic", `stream failed: ${await res.text()}`, res.status);
    }

    const openToolUses = new Map<number, string>();
    let usage: UsageInfo = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    for await (const frame of parseSSEStream(res.body)) {
      if (!frame.data) continue;
      const evt = JSON.parse(frame.data);
      switch (evt.type) {
        case "message_start":
          usage = extractUsage(evt.message.usage);
          break;
        case "content_block_start":
          if (evt.content_block.type === "tool_use") {
            openToolUses.set(evt.index, evt.content_block.id);
            yield { type: "tool_use_start", id: evt.content_block.id, name: evt.content_block.name };
          }
          break;
        case "content_block_delta":
          if (evt.delta.type === "text_delta") {
            yield { type: "text_delta", text: evt.delta.text };
          } else if (evt.delta.type === "input_json_delta") {
            const id = openToolUses.get(evt.index);
            if (id) yield { type: "tool_use_delta", id, inputDelta: evt.delta.partial_json };
          }
          break;
        case "content_block_stop": {
          const id = openToolUses.get(evt.index);
          if (id) yield { type: "tool_use_end", id };
          break;
        }
        case "message_delta":
          if (evt.delta?.stop_reason) stopReason = fromAnthropicStopReason(evt.delta.stop_reason);
          if (evt.usage) usage = { ...usage, ...extractUsage(evt.usage) };
          break;
        case "message_stop":
          yield { type: "message_end", stopReason, usage };
          break;
        case "error":
          yield { type: "error", message: evt.error?.message ?? "unknown stream error" };
          break;
      }
    }
  }

  async function countTokens(req: ChatRequest): Promise<number> {
    const res = await fetch(`${API_BASE}/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(req)),
    });
    if (!res.ok) {
      throw new ProviderError("anthropic", `countTokens failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as { input_tokens: number };
    return body.input_tokens;
  }

  function pricing(model: string): ModelPricing | undefined {
    const table = pricingTable as Record<string, ModelPricing>;
    if (table[model]) return table[model];
    const prefixMatch = Object.keys(table).find((k) => model.startsWith(k));
    return prefixMatch ? table[prefixMatch] : undefined;
  }

  return {
    id: "anthropic",
    displayName: "Anthropic",
    supportsCaching: true,
    cacheStrategy: "anthropic-breakpoints",
    listModels,
    chat,
    stream,
    countTokens,
    pricing,
  };
}
