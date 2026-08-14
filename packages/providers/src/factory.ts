import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAIAdapter } from "./openai.js";
import { createGoogleAdapter } from "./google.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible.js";
import type { ProviderAdapter, ProviderCredentials } from "./types.js";

export const SUPPORTED_PROVIDERS = ["anthropic", "openai", "google", "openai-compatible"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

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
      });
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown provider: ${exhaustive}`);
    }
  }
}
