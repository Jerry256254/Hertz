import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAIAdapter } from "./openai.js";
import { createGoogleAdapter } from "./google.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";
import type { ModelPricing, ProviderAdapter, ProviderCredentials } from "./types.js";
import compatiblePricing from "./pricing/openai-compatible.json" with { type: "json" };

export const SUPPORTED_PROVIDERS = ["anthropic", "openai", "google", "openai-compatible"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** Approximate per-model pricing for known OpenAI-compatible backends (host match); unknown hosts cost $0 until priced. */
function pricingTableForBaseUrl(baseUrl: string): Record<string, ModelPricing> | undefined {
  let host = "";
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
  if (host.startsWith("_")) return undefined;
  const table = (compatiblePricing as unknown as Record<string, Record<string, ModelPricing>>)[host];
  return table;
}

export function createProviderAdapter(
  provider: SupportedProvider,
  creds: ProviderCredentials,
): ProviderAdapter {
  switch (provider) {
    case "anthropic":
      return createAnthropicAdapter(creds);
    case "openai":
      return createOpenAIAdapter(creds);
    case "google":
      return createGoogleAdapter(creds);
    case "openai-compatible":
      if (!creds.baseUrl) {
        throw new Error("openai-compatible provider requires a baseUrl");
      }
      return createOpenAICompatibleAdapter({
        id: "openai-compatible",
        displayName: "OpenAI-compatible",
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
        cacheStrategy: "none",
        pricingTable: pricingTableForBaseUrl(creds.baseUrl),
      });
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown provider: ${exhaustive}`);
    }
  }
}
