import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agents, providerConfigs } from "../db/schema.js";
import { decryptSecret } from "../secrets/key-encryption.js";
import { loadAgentMemoryConfig } from "./config.js";

/**
 * Text → vector embeddings through any OpenAI-compatible `/embeddings`
 * endpoint, reusing the agent's own provider credentials (same pattern as
 * TencentDB's OpenAI embedding provider). Providers without an
 * OpenAI-compatible embeddings API resolve to null — recall then stays
 * keyword-only instead of failing.
 */

export interface Embedder {
  model: string;
  dimensions: number;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface EmbedderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  sendDimensions: boolean;
  timeoutMs: number;
  maxInputChars: number;
}

export function createOpenAIEmbedder(opts: EmbedderOptions): Embedder {
  return {
    model: opts.model,
    dimensions: opts.dimensions,
    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const input = texts.map((t) => t.slice(0, opts.maxInputChars));
      const body: Record<string, unknown> = { model: opts.model, input };
      if (opts.sendDimensions) body.dimensions = opts.dimensions;
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const parsed = (await res.json()) as { data?: Array<{ embedding?: unknown; index?: number }> };
      if (!Array.isArray(parsed.data) || parsed.data.length !== input.length) {
        throw new Error("embeddings response shape mismatch");
      }
      const ordered = [...parsed.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return ordered.map((row) => {
        if (!Array.isArray(row.embedding) || row.embedding.length !== opts.dimensions) {
          throw new Error(`embedding dims mismatch (want ${opts.dimensions})`);
        }
        return (row.embedding as number[]).map(Number);
      });
    },
  };
}

// The registry holds the master key after boot so recall paths (prompt
// building, tools) can resolve an embedder without threading secrets through
// every caller. Process-local by design — never serialized, never logged.
let registryKey: Buffer | null = null;
const embedderCache = new Map<string, Embedder | null>();

export function initMemoryEmbedderRegistry(masterKey: Buffer): void {
  registryKey = masterKey;
  embedderCache.clear();
}

/** For tests: point resolution at a stub without touching the real registry. */
export function __setCachedEmbedderForTest(cacheKey: string, embedder: Embedder | null): void {
  embedderCache.set(cacheKey, embedder);
}

export function __clearEmbedderCacheForTest(): void {
  embedderCache.clear();
}

/**
 * Resolves the embedder for an agent: OpenAI native, or any
 * openai-compatible provider with a baseUrl. Anthropic/Google native have no
 * OpenAI-compatible embeddings endpoint → null (keyword-only recall).
 */
export async function getAgentEmbedder(db: Database, agentId: string): Promise<Embedder | null> {
  const config = loadAgentMemoryConfig();
  try {
    const agentRows = await db.select({ providerConfigId: agents.providerConfigId }).from(agents).where(eq(agents.id, agentId)).limit(1);
    const agent = agentRows[0];
    if (!agent || !registryKey) return null;
    const cacheKey = `${agent.providerConfigId}::${config.embedModel}::${config.embedDimensions}`;
    if (embedderCache.has(cacheKey)) return embedderCache.get(cacheKey)!;
    const pcRows = await db.select().from(providerConfigs).where(eq(providerConfigs.id, agent.providerConfigId)).limit(1);
    const pc = pcRows[0];
    if (!pc) {
      embedderCache.set(cacheKey, null);
      return null;
    }
    const baseUrl = pc.baseUrl ?? (pc.provider === "openai" ? "https://api.openai.com/v1" : null);
    if (!baseUrl || (pc.provider !== "openai" && pc.provider !== "openai-compatible")) {
      embedderCache.set(cacheKey, null);
      return null;
    }
    const embedder = createOpenAIEmbedder({
      baseUrl,
      apiKey: decryptSecret(registryKey, pc.encryptedKey),
      model: config.embedModel,
      dimensions: config.embedDimensions,
      sendDimensions: config.embedSendDimensions,
      timeoutMs: config.embedTimeoutMs,
      maxInputChars: config.embedMaxInputChars,
    });
    embedderCache.set(cacheKey, embedder);
    return embedder;
  } catch {
    return null;
  }
}
