import { asc, eq } from "drizzle-orm";
import {
  createProviderAdapter,
  ProviderError,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type ModelPricing,
  type ProviderAdapter,
  type StreamEvent,
  type SupportedProvider,
} from "@kuclab-hertz/providers";
import type { ProviderPort } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { providerConfigKeys, providerConfigs } from "../db/schema.js";
import { decryptSecret } from "../secrets/key-encryption.js";

/** 429 is the unambiguous "try a different key" signal. Some providers use 403 for exhausted free-tier quota too. */
function isRotatable(err: unknown): boolean {
  return err instanceof ProviderError && (err.status === 429 || err.status === 403);
}

/**
 * Wraps N single-key adapters for the same provider config behind one ProviderAdapter,
 * so a session using this config doesn't need to know it has multiple keys. Rotation is a
 * simple round-robin cursor shared across calls (spreads load even absent errors), plus
 * on-error retry into the next key. Streaming can only be safely retried if the failure
 * happens before any event has been yielded to the caller — once partial output has been
 * emitted, a retry would duplicate or corrupt it, so we let the error propagate instead.
 */
function createRotatingAdapter(adapters: ProviderAdapter[]): ProviderAdapter {
  if (adapters.length === 1) return adapters[0]!;
  let cursor = 0;
  const first = adapters[0]!;

  function order(): ProviderAdapter[] {
    const start = cursor % adapters.length;
    cursor = (cursor + 1) % adapters.length;
    return [...adapters.slice(start), ...adapters.slice(0, start)];
  }

  return {
    id: first.id,
    displayName: first.displayName,
    supportsCaching: first.supportsCaching,
    cacheStrategy: first.cacheStrategy,

    async listModels(): Promise<ModelInfo[]> {
      return first.listModels();
    },

    pricing(model: string): ModelPricing | undefined {
      return first.pricing(model);
    },

    async countTokens(req: ChatRequest): Promise<number> {
      return first.countTokens(req);
    },

    async chat(req: ChatRequest): Promise<ChatResponse> {
      let lastErr: unknown;
      for (const adapter of order()) {
        try {
          return await adapter.chat(req);
        } catch (err) {
          lastErr = err;
          if (!isRotatable(err)) throw err;
        }
      }
      throw lastErr;
    },

    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      let lastErr: unknown;
      for (const adapter of order()) {
        let yielded = false;
        try {
          for await (const evt of adapter.stream(req)) {
            yielded = true;
            yield evt;
          }
          return;
        } catch (err) {
          lastErr = err;
          if (yielded || !isRotatable(err)) throw err;
        }
      }
      throw lastErr;
    },
  };
}

/** Resolves a stored, encrypted ProviderConfig row (plus its key pool) into a ready-to-use, rotating adapter. Adapters are cheap to construct, so no caching beyond this call. */
export function createProviderRegistry(db: Database, masterKey: Buffer): ProviderPort {
  return {
    async getAdapter(providerConfigId: string): Promise<ProviderAdapter> {
      const rows = await db
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.id, providerConfigId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error(`Unknown provider config: ${providerConfigId}`);

      const poolRows = await db
        .select()
        .from(providerConfigKeys)
        .where(eq(providerConfigKeys.providerConfigId, providerConfigId))
        .orderBy(asc(providerConfigKeys.createdAt));

      const encryptedKeys = [row.encryptedKey, ...poolRows.map((r) => r.encryptedKey)];
      const adapters = encryptedKeys.map((encryptedKey) =>
        createProviderAdapter(row.provider as SupportedProvider, {
          apiKey: decryptSecret(masterKey, encryptedKey),
          baseUrl: row.baseUrl ?? undefined,
        }),
      );
      return createRotatingAdapter(adapters);
    },
  };
}
