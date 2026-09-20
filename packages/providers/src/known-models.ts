import type { ModelInfo } from "./types.js";

/**
 * Curated model ids merged UNDER live /models results (scan wins on conflict).
 * Some first-party endpoints lag behind releases or hide new ids from /models
 * for weeks — without this the picker silently misses models the API already
 * serves. Keep entries minimal and factual: id + rough capabilities.
 */
const KNOWN_BY_HOST: Record<string, ModelInfo[]> = {
  "api.deepseek.com": [
    // V4.1 generation (Sept 2026): first-party id is deepseek-flash; gateways use deepseek-v4.1-flash.
    { id: "deepseek-flash", displayName: "deepseek-flash", supportsTools: true, supportsVision: true },
    { id: "deepseek-v4.1-flash", displayName: "deepseek-v4.1-flash", supportsTools: true, supportsVision: true },
    { id: "deepseek-v4-pro", displayName: "deepseek-v4-pro", supportsTools: true, supportsVision: false },
    { id: "deepseek-v4-flash", displayName: "deepseek-v4-flash", supportsTools: true, supportsVision: false },
    // Retired 2026-07-24 aliases — kept last so old configs still resolve.
    { id: "deepseek-chat", displayName: "deepseek-chat", supportsTools: true, supportsVision: false },
    { id: "deepseek-reasoner", displayName: "deepseek-reasoner", supportsTools: true, supportsVision: false },
  ],
};

/** Extra ids for an OpenAI-compatible base URL (empty when the host is unknown). */
export function knownModelsForEndpoint(baseUrl: string): ModelInfo[] {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return KNOWN_BY_HOST[host] ?? [];
  } catch {
    return [];
  }
}

/** Union of scanned + known ids; scanned entries win, order preserved (scanned first). */
export function mergeModelLists(scanned: ModelInfo[], known: ModelInfo[]): ModelInfo[] {
  const seen = new Set(scanned.map((m) => m.id));
  const out = [...scanned];
  for (const m of known) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}
