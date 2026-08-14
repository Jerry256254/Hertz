import { createOpenAICompatibleAdapter } from "./openai-compatible.js";
import type { ModelPricing, ProviderAdapter, ProviderCredentials } from "./types.js";
import pricingTable from "./pricing/openai.json" with { type: "json" };

export function createOpenAIAdapter(creds: ProviderCredentials): ProviderAdapter {
  return createOpenAICompatibleAdapter({
    id: "openai",
    displayName: "OpenAI",
    baseUrl: creds.baseUrl ?? "https://api.openai.com/v1",
    apiKey: creds.apiKey,
    cacheStrategy: "openai-automatic",
    pricingTable: pricingTable as Record<string, ModelPricing>,
  });
}
