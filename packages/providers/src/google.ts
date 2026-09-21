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
import pricingTable from "./pricing/google.json" with { type: "json" };

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const CHAT_TIMEOUT_MS = 30_000;
const SCAN_TIMEOUT_MS = 15_000;
const COUNT_TIMEOUT_MS = 15_000;
const STREAM_INACTIVITY_MS = 90_000;

/**
 * Normalize a model id for the REST path. Scan results store the bare id
 * ("gemini-2.0-flash"), but a hand-typed id may already carry the resource
 * prefix ("models/…", "tunedModels/…") — both must hit the same URL.
 */
function modelPath(model: string): string {
  const m = model.trim();
  if (m.startsWith("models/") || m.startsWith("tunedModels/")) return m;
  return `models/${m}`;
}

function toGeminiContents(messages: ChatRequest["messages"]) {
  // Build map of tool_use id -> name for tool_result name lookup (Gemini needs NAME, not ID)
  const idToName = new Map<string, string>();
  for (const m of messages) for (const b of m.content) if (b.type === "tool_use") idToName.set(b.id, b.name);
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
          return { functionResponse: { name: idToName.get(block.toolUseId) ?? block.toolUseId, response: { content: block.content } } };
      }
    }),
  }));
}

function fromFinishReason(reason: string | undefined, hasToolUse: boolean): StopReason {
  // Gemini reports finishReason "STOP" even when the response carries
  // functionCall parts — detect tool_use from the parts, not the reason.
  if (hasToolUse) return "tool_use";
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
    // Paginated via nextPageToken — one page silently drops models.
    const out: ModelInfo[] = [];
    let pageToken = "";
    for (let page = 0; page < 10; page++) {
      const res = await fetch(
        `${API_BASE}/models?key=${key}&pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        { signal: withTimeout(undefined, SCAN_TIMEOUT_MS) },
      );
      if (!res.ok) {
        throw new ProviderError("google", `listModels failed: ${await res.text()}`, res.status);
      }
      const body = (await res.json()) as {
        models?: Array<{
          name: string;
          displayName?: string;
          inputTokenLimit?: number;
          outputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }>;
        nextPageToken?: string;
        error?: { message?: string };
      };
      const models = body.models ?? [];
      if (models.length === 0 && body.error?.message) {
        throw new ProviderError("google", `listModels failed: ${body.error.message}`, res.status);
      }
      for (const m of models) {
        const name = m.name ?? "";
        const methods = m.supportedGenerationMethods ?? [];
        // Prefer the capability list over name matching so tuned models and
        // Gemma variants aren't silently dropped from the picker.
        const usable = methods.includes("generateContent") || /gemini|gemma/i.test(name);
        if (!usable) continue;
        out.push({
          id: name.replace(/^(models|tunedModels)\//, ""),
          displayName: m.displayName ?? name,
          contextWindow: m.inputTokenLimit,
          maxOutputTokens: m.outputTokenLimit,
          supportsTools: true,
          supportsVision: true,
        });
      }
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return out;
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${API_BASE}/${modelPath(req.model)}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody(req)),
      signal: withTimeout(req.signal, CHAT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new ProviderError("google", `chat failed: ${await res.text()}`, res.status);
    }
    const body = (await res.json()) as any;
    // A safety-blocked prompt returns HTTP 200 with no candidates at all.
    const candidate = body.candidates?.[0];
    if (!candidate) {
      const blockReason = body.promptFeedback?.blockReason;
      throw new ProviderError(
        "google",
        blockReason ? `chat blocked by safety filter (${blockReason})` : "chat returned no candidates",
        res.status,
      );
    }
    const parts: any[] = candidate.content?.parts ?? [];
    const content: ContentBlock[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.functionCall) {
        content.push({
          type: "tool_use",
          id: `${candidate.index ?? 0}-${i}`,
          name: p.functionCall.name,
          input: p.functionCall.args,
        });
      } else if (p.text) {
        content.push({ type: "text", text: p.text });
      }
    }
    return {
      content,
      stopReason: fromFinishReason(
        candidate.finishReason,
        content.some((b) => b.type === "tool_use"),
      ),
      usage: extractUsage(body.usageMetadata),
      model: req.model,
    };
  }

  async function* stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const res = await fetch(`${API_BASE}/${modelPath(req.model)}:streamGenerateContent?alt=sse&key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody(req)),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw new ProviderError("google", `stream failed: ${await res.text()}`, res.status);
    }

    let usage: UsageInfo = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let toolCallSeq = 0;
    let sawToolUse = false;

    try {
      for await (const frame of parseSSEStream(res.body, { inactivityMs: STREAM_INACTIVITY_MS })) {
        if (!frame.data) continue;
        let chunk: any;
        try {
          chunk = JSON.parse(frame.data);
        } catch {
          continue; // malformed frame — skip it, don't kill the run
        }
        if (chunk.usageMetadata) usage = extractUsage(chunk.usageMetadata);
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;
        if (candidate.finishReason) stopReason = fromFinishReason(candidate.finishReason, sawToolUse);
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) yield { type: "text_delta", text: part.text };
          if (part.functionCall) {
            sawToolUse = true;
            const id = `${toolCallSeq++}`;
            yield { type: "tool_use_start", id, name: part.functionCall.name };
            yield { type: "tool_use_delta", id, inputDelta: JSON.stringify(part.functionCall.args ?? {}) };
            yield { type: "tool_use_end", id };
          }
        }
      }
    } catch (err) {
      if (err instanceof StreamStallError) throw new ProviderError("google", err.message, 408);
      throw err;
    }
    yield { type: "message_end", stopReason: sawToolUse ? "tool_use" : stopReason, usage };
  }

  async function countTokens(req: ChatRequest): Promise<number> {
    const body2 = buildBody(req);
    const res = await fetch(`${API_BASE}/${modelPath(req.model)}:countTokens?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: body2.contents, systemInstruction: body2.systemInstruction, tools: body2.tools }),
      signal: withTimeout(req.signal, COUNT_TIMEOUT_MS),
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
