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
import pricingTable from "./pricing/google.json" with { type: "json" };

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function toGeminiContents(messages: ChatRequest["messages"]) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.content.map((block) => {
      switch (block.type) {
        case "text":
          return { text: block.text };
        case "image":
          return { inlineData: { mimeType: block.mimeType, data: block.data } };
        case "tool_use":
          return { functionCall: { name: block.name, args: block.input } };
        case "tool_result":
          return { functionResponse: { name: block.toolUseId, response: { content: block.content } } };
      }
    }),
  }));
}

function fromFinishReason(reason: string | undefined): StopReason {
  if (reason === "MAX_TOKENS") return "max_tokens";
  return "end_turn";
}

function extractUsage(usageMetadata: any): UsageInfo {
  return {
    inputTokens: usageMetadata?.promptTokenCount ?? 0,
    outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
    cachedInputTokens: usageMetadata?.cachedContentTokenCount ?? 0,
  };
}

function buildBody(req: ChatRequest) {
  return {
    systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
    contents: toGeminiContents(req.messages),
    tools: req.tools?.length
      ? [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            })),
          },
        ]
      : undefined,
    generationConfig: {
      maxOutputTokens: req.maxTokens,
      temperature: req.temperature,
    },
  };
}

export function createGoogleAdapter(creds: ProviderCredentials): ProviderAdapter {
  const key = creds.apiKey;

  async function listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${API_BASE}/models?key=${key}&pageSize=200`);
    if (!res.ok) {
      throw new ProviderError("google", `listModels failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as { models: Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number }> };
    return body.models
      .filter((m) => m.name.includes("gemini"))
      .map((m) => ({
        id: m.name.replace(/^models\//, ""),
        displayName: m.displayName ?? m.name,
        contextWindow: m.inputTokenLimit,
        maxOutputTokens: m.outputTokenLimit,
        supportsTools: true,
        supportsVision: true,
      }));
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${API_BASE}/models/${req.model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody(req)),
    });
    if (!res.ok) {
      throw new ProviderError("google", `chat failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as any;
    const candidate = body.candidates[0];
    const content: ContentBlock[] = (candidate.content?.parts ?? []).map((p: any, i: number) =>
      p.functionCall
        ? { type: "tool_use", id: `${candidate.index ?? 0}-${i}`, name: p.functionCall.name, input: p.functionCall.args }
        : { type: "text", text: p.text ?? "" },
    );
    return {
      content,
      stopReason: fromFinishReason(candidate.finishReason),
      usage: extractUsage(body.usageMetadata),
      model: req.model,
    };
  }

  async function* stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const res = await fetch(`${API_BASE}/models/${req.model}:streamGenerateContent?alt=sse&key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody(req)),
    });
    if (!res.ok || !res.body) {
      throw new ProviderError("google", `stream failed: ${await res.text()}`, res.status);
    }

    let usage: UsageInfo = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let toolCallSeq = 0;

    for await (const frame of parseSSEStream(res.body)) {
      if (!frame.data) continue;
      const chunk = JSON.parse(frame.data);
      if (chunk.usageMetadata) usage = extractUsage(chunk.usageMetadata);
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) stopReason = fromFinishReason(candidate.finishReason);
      for (const part of candidate.content?.parts ?? []) {
        if (part.text) yield { type: "text_delta", text: part.text };
        if (part.functionCall) {
          const id = `${toolCallSeq++}`;
          yield { type: "tool_use_start", id, name: part.functionCall.name };
          yield { type: "tool_use_delta", id, inputDelta: JSON.stringify(part.functionCall.args ?? {}) };
          yield { type: "tool_use_end", id };
        }
      }
    }
    yield { type: "message_end", stopReason, usage };
  }

  async function countTokens(req: ChatRequest): Promise<number> {
    const res = await fetch(`${API_BASE}/models/${req.model}:countTokens?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: toGeminiContents(req.messages) }),
    });
    if (!res.ok) {
      throw new ProviderError("google", `countTokens failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as { totalTokens: number };
    return body.totalTokens;
  }

  function pricing(model: string): ModelPricing | undefined {
    const table = pricingTable as Record<string, ModelPricing>;
    if (table[model]) return table[model];
    const prefixMatch = Object.keys(table).find((k) => model.startsWith(k));
    return prefixMatch ? table[prefixMatch] : undefined;
  }

  return {
    id: "google",
    displayName: "Google",
    supportsCaching: false,
    cacheStrategy: "none",
    listModels,
    chat,
    stream,
    countTokens,
    pricing,
  };
}
