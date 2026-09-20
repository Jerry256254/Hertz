import { ProviderError } from "./types.js";

/**
 * Turns a model-scan failure into an actionable message for the settings UI.
 * Scan runs server-side, so the #1 confusion is a `localhost` base URL (Ollama,
 * LM Studio) that is reachable from the user's browser but NOT from the Hertz
 * server process — the hint says exactly that. Never includes the API key.
 */
export function describeScanError(err: unknown, providerId: string, baseUrl?: string): string {
  const status = err instanceof ProviderError ? err.status : undefined;
  const raw = err instanceof Error ? err.message : String(err);
  const shownUrl = baseUrl ? scrubUrlCredentials(baseUrl) : undefined;
  const where = shownUrl ? ` (${shownUrl})` : "";

  if (status === 401 || status === 403) {
    return (
      `Poskytovatel odmítl přihlášení (HTTP ${status}) — zkontroluj API klíč u poskytovatele „${providerId}" ` +
      `a ulož ho znovu v nastavení. Detail: ${truncateProviderBody(raw)}`
    );
  }
  if (status === 404) {
    return (
      `Seznam modelů na této adrese neexistuje (HTTP 404)${where} — zkontroluj baseUrl, ` +
      `většinou musí končit „/v1" (např. http://192.168.1.10:11434/v1).`
    );
  }
  if (status === 429) {
    return `Poskytovatel dočasně odmítá požadavky (rate limit, HTTP 429) — chvíli počkej a zkus seznam načíst znovu.`;
  }
  if (isConnectFailure(raw)) {
    if (shownUrl && baseUrl && isLocalhostUrl(baseUrl)) {
      return (
        `Na ${shownUrl} se server nedokáže připojit — seznam modelů načítá Hertz server, ne tvůj prohlížeč. ` +
        `Běží poskytovatel na jiném stroji než server? Pak místo „localhost" zadej jeho LAN adresu ` +
        `(např. http://192.168.1.10:11434/v1). Model jde mezitím napsat ručně.`
      );
    }
    return (
      `Na ${shownUrl || `poskytovatele „${providerId}"`} se server nedokáže připojit${where} — ` +
      `zkontroluj adresu a síťové připojení serveru. Model jde mezitím napsat ručně.`
    );
  }
  return `Seznam modelů se nepodařilo načíst${where}: ${truncateProviderBody(raw)} Model jde napsat ručně.`;
}

function isConnectFailure(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|network/i.test(message);
}

function isLocalhostUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Strips userinfo (user:password@) so echoed URLs can never leak credentials. */
function scrubUrlCredentials(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/:\/\/[^/@]+@/, "://");
  }
}

/** Provider error bodies can be long HTML pages — keep the first meaningful line. */
function truncateProviderBody(message: string): string {
  const firstLine = message.split("\n")[0] ?? "";
  const cleaned = firstLine.replace(/<[^>]*>/g, "").trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 220)}…` : cleaned;
}
