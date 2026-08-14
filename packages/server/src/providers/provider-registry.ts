import { eq } from "drizzle-orm";
import { createProviderAdapter, type ProviderAdapter, type SupportedProvider } from "@kuclab-hertz/providers";
import type { ProviderPort } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { providerConfigs } from "../db/schema.js";
import { decryptSecret } from "../secrets/key-encryption.js";

/** Resolves a stored, encrypted ProviderConfig row into a ready-to-use adapter. Adapters are cheap to construct, so no caching beyond this call. */
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

      const apiKey = decryptSecret(masterKey, row.encryptedKey);
      return createProviderAdapter(row.provider as SupportedProvider, {
        apiKey,
        baseUrl: row.baseUrl ?? undefined,
      });
    },
  };
}
