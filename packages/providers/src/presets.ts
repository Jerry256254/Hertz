import type { SupportedProvider } from "./factory.js";

export type PresetCategory = "frontier" | "aggregator" | "local";

export interface ProviderPreset {
  id: string;
  name: string;
  kind: SupportedProvider;
  category: PresetCategory;
  /** Prefilled for openai-compatible presets; empty string means the user must supply it. */
  baseUrl?: string;
  /** Short domain/host shown next to the name in the picker. */
  hint: string;
}

/**
 * Curated catalog surfaced in the WebUI's "add provider" picker. Everything besides
 * the three native adapters (Anthropic/OpenAI/Google) rides the generic
 * openai-compatible adapter — adding a new aggregator is a data entry, not new code.
 * Base URLs are best-effort from public docs; the picker prefills them but the field
 * stays editable since providers occasionally change paths.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  // --- Native adapters ---
  { id: "anthropic", name: "Anthropic", kind: "anthropic", category: "frontier", hint: "api.anthropic.com" },
  { id: "openai", name: "OpenAI", kind: "openai", category: "frontier", hint: "api.openai.com" },
  { id: "google", name: "Google Gemini", kind: "google", category: "frontier", hint: "generativelanguage.googleapis.com" },

  // --- Frontier labs via OpenAI-compatible endpoints ---
  {
    id: "xai",
    name: "xAI (Grok)",
    kind: "openai-compatible",
    category: "frontier",
    baseUrl: "https://api.x.ai/v1",
    hint: "api.x.ai",
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "openai-compatible",
    category: "frontier",
    baseUrl: "https://api.mistral.ai/v1",
    hint: "api.mistral.ai",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen Gateway (free)",
    kind: "openai-compatible",
    category: "frontier",
    baseUrl: "https://opencode.ai/zen/v1",
    hint: "FREE via gateway — works with no API key; optionally paste one from `opencode auth login` for more models",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai-compatible",
    category: "frontier",
    baseUrl: "https://api.deepseek.com/v1",
    hint: "api.deepseek.com",
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    kind: "openai-compatible",
    category: "frontier",
    baseUrl: "https://api.moonshot.cn/v1",
    hint: "api.moonshot.cn",
  },
  {
    id: "qwen",
    name: "Alibaba Qwen",
    kind: "openai-compatible",
    category: "frontier",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    hint: "dashscope.aliyuncs.com",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    kind: "openai-compatible",
    category: "frontier",
    baseUrl: "https://api.perplexity.ai",
    hint: "api.perplexity.ai",
  },

  // --- Aggregators / inference clouds ---
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "https://openrouter.ai/api/v1",
    hint: "openrouter.ai",
  },
  {
    id: "groq",
    name: "Groq",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "https://api.groq.com/openai/v1",
    hint: "api.groq.com",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "https://api.cerebras.ai/v1",
    hint: "api.cerebras.ai",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    hint: "integrate.api.nvidia.com",
  },
  {
    id: "together",
    name: "Together AI",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "https://api.together.xyz/v1",
    hint: "api.together.xyz",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    hint: "api.fireworks.ai",
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    hint: "api.deepinfra.com",
  },
  {
    id: "sambanova",
    name: "SambaNova Cloud",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "https://api.sambanova.ai/v1",
    hint: "api.sambanova.ai",
  },
  {
    id: "hyperbolic",
    name: "Hyperbolic",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    hint: "api.hyperbolic.xyz",
  },
  {
    id: "agentrouter",
    name: "AgentRouter.org",
    kind: "openai-compatible",
    category: "aggregator",
    baseUrl: "",
    hint: "verify base URL in your AgentRouter dashboard",
  },

  // --- Local & self-hosted ---
  {
    id: "ollama",
    name: "Ollama",
    kind: "openai-compatible",
    category: "local",
    baseUrl: "http://localhost:11434/v1",
    hint: "localhost:11434",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "openai-compatible",
    category: "local",
    baseUrl: "http://localhost:1234/v1",
    hint: "localhost:1234",
  },
  {
    id: "vllm",
    name: "vLLM",
    kind: "openai-compatible",
    category: "local",
    baseUrl: "",
    hint: "self-hosted — enter your server URL",
  },
  {
    id: "custom",
    name: "Custom",
    kind: "openai-compatible",
    category: "local",
    baseUrl: "",
    hint: "any OpenAI-compatible endpoint",
  },
];
