import { ProviderError } from "./types.js";

/**
 * Turns any error that would otherwise reach a human (web chat, Telegram, ...)
 * into a short, friendly Czech message with zero technical detail. The raw
 * error (JSON bodies, provider ids, stack traces) must never be shown to the
 * user — the caller is expected to log it server-side instead.
 */
export function friendlyChatError(err: unknown): string {
  const status = err instanceof ProviderError ? err.status : undefined;
  const raw = err instanceof Error ? err.message : String(err);

  if (status === 401 || status === 403 || /unauthorized|invalid api key|invalid_api_key|authentication/i.test(raw)) {
    return "Nepodařilo se připojit k AI — zkontroluj API klíč v nastavení poskytovatele.";
  }
  if (status === 429 || /rate limit|rate_limit|too many requests/i.test(raw)) {
    return "AI je teď přetížená — zkus to prosím za chvíli znovu.";
  }
  if (status === 404 || status === 400 || /model|not supported|invalid_request/i.test(raw)) {
    return "Zvolený model teď není dostupný — zkontroluj nastavení modelu a zkus to znovu.";
  }
  if (status === 408 || status === 425 || (status !== undefined && status >= 500)) {
    return "AI teď neodpovídá — zkus to prosím za chvíli znovu.";
  }
  if (isNetworkFailure(raw)) {
    return "Nepodařilo se spojit s AI — zkontroluj připojení k internetu a zkus to znovu.";
  }
  return "Něco se při odpovědi pokazilo — zkus to prosím znovu.";
}

function isNetworkFailure(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|network|socket hang up/i.test(
    message,
  );
}
