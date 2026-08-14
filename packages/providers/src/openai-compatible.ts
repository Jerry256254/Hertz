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
        out.push({
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
  const headers = {
    authorization: `Bearer ${opts.apiKey}`,
    "content-type": "application/json",
  };

  async function listModels(): Promise<ModelInfo[]> {
    if (opts.listModelsOverride) return opts.listModelsOverride();
    const res = await fetch(`${opts.baseUrl}/models`, { headers });
    if (!res.ok) {
      throw new ProviderError(opts.id, `listModels failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as { data: Array<{ id: string }> };
    return body.data.map((m) => ({ id: m.id, displayName: m.id, supportsTools: true }));
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(req, false)),
    });
    if (!res.ok) {
      throw new ProviderError(opts.id, `chat failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as any;
    const choice = body.choices[0];
    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const call of choice.message.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments || "{}"),
      });
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
    });
    if (!res.ok || !res.body) {
      throw new ProviderError(opts.id, `stream failed: ${await res.text()}`, res.status);
    }

    const toolCallNames = new Map<number, string>();
    const toolCallIds = new Map<number, string>();
    let usage: UsageInfo = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    for await (const frame of parseSSEStream(res.body)) {
      if (!frame.data || frame.data === "[DONE]") continue;
      const chunk = JSON.parse(frame.data);
      if (chunk.usage) usage = extractUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (delta.content) {
        yield { type: "text_delta", text: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        const idx = call.index;
        if (call.id) {
          toolCallIds.set(idx, call.id);
          toolCallNames.set(idx, call.function?.name ?? "");
          yield { type: "tool_use_start", id: call.id, name: call.function?.name ?? "" };
        }
        if (call.function?.arguments) {
          const id = toolCallIds.get(idx);
          if (id) yield { type: "tool_use_delta", id, inputDelta: call.function.arguments };
        }
      }
      if (choice.finish_reason) {
        stopReason = fromFinishReason(choice.finish_reason);
        for (const id of toolCallIds.values()) yield { type: "tool_use_end", id };
        yield { type: "message_end", stopReason, usage };
      }
    }
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
    const prefixMatch = Object.keys(table).find((k) => model.startsWith(k));
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
