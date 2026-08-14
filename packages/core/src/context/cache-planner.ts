import type { ProviderAdapter } from "@kuclab-hertz/providers";

/**
 * How many leading messages (out of `messageCount`) are stable/cache-eligible for
 * this request. 'anthropic-breakpoints' caches everything except the newest turn
 * (explicit cache_control, handled by the adapter). 'openai-automatic' relies on
 * the provider's own prefix caching, which only helps if message ordering/content
 * stays byte-identical for the cached prefix — we still report the same prefix
 * count so callers building the request keep that prefix untouched. 'none' caches
 * nothing.
 */
export function planCachePrefix(adapter: ProviderAdapter, messageCount: number): number {
  if (adapter.cacheStrategy === "none" || messageCount <= 1) return 0;
  return messageCount - 1;
}
