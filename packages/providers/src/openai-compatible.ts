import { parseSSEStream, StreamStallError } from "./sse.js";
import { withTimeout } from "./signal.js";
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
import { knownModelsForEndpoint, mergeModelLists } from "./known-models.js";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<Record<string, unknown>>;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function toOpenAIMessages(system: string | undefined, messages: ChatRequest["messages"]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const msg of messages) {
    const textAndImageParts: Array<Record<string, unknown>> = [];
    const toolCalls: OpenAIMessage["tool_calls"] = [];
    const toolResults: OpenAIMessage[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        textAndImageParts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        textAndImageParts.push({
          type: "image_url",
          image_url: { url: `data:${block.mimeType};base64,${block.data}` },
        });
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: block.content,
        });
      }
    }

    if (textAndImageParts.length > 0 || toolCalls.length > 0) {
      const entry: OpenAIMessage = { role: msg.role };
      if (textAndImageParts.length > 0) {
        entry.content =
          textAndImageParts.length === 1 && textAndImageParts[0]?.type === "text"
            ? (textAndImageParts[0].text as string)
            : textAndImageParts;
      }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
    }
    // Tool results must immediately follow the assistant message that made the calls (OpenAI requirement)
    for (const tr of toolResults) out.push(tr);
  }
  return out;
}

function buildBody(req: ChatRequest, stream: boolean) {
  return {
    model: req.model,
    messages: toOpenAIMessages(req.system, req.messages),
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    tools: req.tools?.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function fromFinishReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function extractUsage(usage: any): UsageInfo {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

const CHAT_TIMEOUT_MS = 30_000;
const SCAN_TIMEOUT_MS = 15_000;
const STREAM_INACTIVITY_MS = 90_000;

export interface OpenAICompatibleOptions {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  /** Automatic prefix caching (OpenAI, some compatible backends) vs none (most local runners). */
  cacheStrategy?: "openai-automatic" | "none";
  pricingTable?: Record<string, ModelPricing>;
  /** Some local runners (Ollama, LM Studio) don't expose /models with the same shape; override if needed. */
  listModelsOverride?: () => Promise<ModelInfo[]>;
}

export function createOpenAICompatibleAdapter(opts: OpenAICompatibleOptions): ProviderAdapter {
  // Keyless gateways (e.g. OpenCode Zen free tier) omit the Authorization
  // header entirely when no API key is configured.
  const headers = {
    ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    "content-type": "application/json",
  };

  async function listModels(): Promise<ModelInfo[]> {
    if (opts.listModelsOverride) return opts.listModelsOverride();
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/models`, {
      headers,
      signal: withTimeout(undefined, SCAN_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new ProviderError(opts.id, `listModels failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as { data?: Array<{ id: string }>; error?: { message?: string } };
    // Some gateways answer errors with HTTP 200 — a missing/invalid `data`
    // array must surface as a ProviderError, not a TypeError on .map.
    if (!Array.isArray(body.data)) {
      throw new ProviderError(
        opts.id,
        `listModels failed: ${body.error?.message ?? "unexpected response shape"}`,
        res.status,
      );
    }
    const scanned = body.data
      .filter((m) => typeof m?.id === "string")
      .map((m) => ({ id: m.id, displayName: m.id, supportsTools: true }));
    if (scanned.length > 0) {
      // A successful non-empty /models response is authoritative: the endpoint
      // decides which ids it serves. Injecting curated ids on top produced
      // picker entries the endpoint then rejected at chat time
      // (invalid_request_error), so never merge here.
      return scanned;
    }
    // Empty list (some local runners expose /models but list nothing) — fall
    // back to curated ids so the picker is not useless.
    return mergeModelLists(scanned, knownModelsForEndpoint(opts.baseUrl));
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(req, false)),
      signal: withTimeout(req.signal, CHAT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new ProviderError(opts.id, `chat failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as any;
    // Some gateways answer errors with HTTP 200 — surface those as a
    // ProviderError instead of crashing on choices[0].
    const choice = body.choices?.[0];
    if (!choice || typeof choice.message !== "object" || choice.message === null) {
      throw new ProviderError(
        opts.id,
        `chat failed: ${body.error?.message ?? "chat returned no choices"}`,
        res.status,
      );
    }
    const message = choice.message;
    const content: ContentBlock[] = [];
    if (message.content) {
      if (typeof message.content === "string") content.push({ type: "text", text: message.content });
      else if (Array.isArray(message.content)) {
        for (const part of message.content) if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
      }
    }
    for (const call of message.tool_calls ?? []) {
      if (typeof call?.id !== "string" || typeof call?.function?.name !== "string") continue;
      let input: unknown = {};
      try {
        input = JSON.parse(call.function.arguments ?? "{}");
      } catch {
        throw new ProviderError(
          opts.id,
          `chat failed: truncated tool-call arguments for "${call.function.name}"`,
          res.status,
        );
      }
      content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
    return {
      content,
      stopReason: fromFinishReason(choice.finish_reason),
      usage: extractUsage(body.usage),
      model: body.model ?? req.model,
    };
  }

  async function* stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(req, true)),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw new ProviderError(opts.id, `stream failed: ${await res.text()}`, res.status);
    }

    const toolCallNames = new Map<number, string>();
    const toolCallIds = new Map<number, string>();
    let usage: UsageInfo = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let finished = false;

    try {
      for await (const frame of parseSSEStream(res.body, { inactivityMs: STREAM_INACTIVITY_MS })) {
        if (!frame.data || frame.data === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(frame.data);
        } catch {
          continue; // malformed frame — skip it, don't kill the run
        }
        if (chunk.usage) usage = extractUsage(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (delta.content) {
          yield { type: "text_delta", text: delta.content };
        }
        for (const call of delta.tool_calls ?? []) {
          const idx = call.index ?? 0;
          if (call.id) {
            toolCallIds.set(idx, call.id);
            toolCallNames.set(idx, call.function?.name ?? toolCallNames.get(idx) ?? "");
            yield { type: "tool_use_start", id: call.id, name: call.function?.name ?? toolCallNames.get(idx) ?? "" };
          } else if (call.function?.name && toolCallIds.has(idx)) {
            toolCallNames.set(idx, call.function.name);
          }
          if (call.function?.arguments) {
            const id = toolCallIds.get(idx);
            if (id) yield { type: "tool_use_delta", id, inputDelta: call.function.arguments };
          }
        }
        // Some gateways repeat finish_reason across chunks — honor it once so
        // tool_use_end / message_end are never emitted twice.
        if (choice.finish_reason && !finished) {
          finished = true;
          stopReason = fromFinishReason(choice.finish_reason);
        }
      }
    } catch (err) {
      if (err instanceof StreamStallError) throw new ProviderError(opts.id, err.message, 408);
      throw err;
    }
    for (const id of toolCallIds.values()) yield { type: "tool_use_end", id };
    yield { type: "message_end", stopReason, usage };
  }

  async function countTokens(req: ChatRequest): Promise<number> {
    // No universal count-tokens endpoint across OpenAI-compatible backends; approximate
    // from character length. Precise session-level budgeting uses core's own estimator.
    const chars = JSON.stringify(toOpenAIMessages(req.system, req.messages)).length;
    return Math.ceil(chars / 4);
  }

  function pricing(model: string): ModelPricing | undefined {
    const table = opts.pricingTable;
    if (!table) return undefined;
    if (table[model]) return table[model];
    const sorted = Object.keys(table).sort((a, b) => b.length - a.length);
    const prefixMatch = sorted.find((k) => model.startsWith(k));
    return prefixMatch ? table[prefixMatch] : undefined;
  }

  return {
    id: opts.id,
    displayName: opts.displayName,
    supportsCaching: (opts.cacheStrategy ?? "none") !== "none",
    cacheStrategy: opts.cacheStrategy ?? "none",
    listModels,
    chat,
    stream,
    countTokens,
    pricing,
  };
}
