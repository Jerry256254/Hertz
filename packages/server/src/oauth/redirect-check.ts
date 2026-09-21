import type { OAuthService } from "./oauth-service.js";

/**
 * Proactive guard for the OAuth start route (see routes/oauth.ts).
 *
 * Google (and Notion) refuse OAuth redirect URIs that point at a private
 * network address or at plain http on a non-loopback host — Google answers
 * with a cryptic "Error 400: invalid_request / device_id and device_name
 * are required for private IP". Instead of sending the user to the provider
 * to fail there, we detect the situation up front and show a plain-Czech
 * explanation.
 *
 * For Google the primary offer is the code-based login (device flow, RFC
 * 8628): it needs no redirect URI at all, so the private address doesn't
 * matter — only the TV client credentials have to be configured. SSH tunnel
 * and a public https domain remain as marginal alternatives for the classic
 * browser-based web flow. Notion has no device flow, so it keeps the
 * tunnel / public domain pair.
 *
 * Accepted redirect targets (what Google/Notion accept):
 *   - https on a public host (domain or public IP)
 *   - http on a loopback host (localhost, 127.0.0.1, [::1])
 * Everything else (private IPv4/IPv6 ranges, link-local, .local-style
 * hostnames, http on a public host) is rejected by the providers.
 */

/** Providers verified to reject private-network redirect URIs. GitHub,
 *  Slack and Mistral restrictions were NOT verified — left out on purpose. */
export const PROVIDERS_REQUIRING_PUBLIC_REDIRECT: ReadonlySet<OAuthService> = new Set<OAuthService>([
  "google",
  "notion",
]);

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function isIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function ipv4Octets(hostname: string): number[] {
  return hostname.split(".").map(Number);
}

function isLoopbackIPv4(hostname: string): boolean {
  return isIPv4(hostname) && ipv4Octets(hostname)[0] === 127;
}

/** IPv4 private ranges (RFC 1918) + link-local (RFC 3927). */
function isPrivateIPv4(hostname: string): boolean {
  if (!isIPv4(hostname)) return false;
  const [a = -1, b = -1] = ipv4Octets(hostname);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function expandIPv6(hostname: string): string | null {
  // Minimal expansion: enough for fc00::/7 and fe80::/10 prefix checks.
  const h = stripBrackets(hostname).toLowerCase();
  if (!h.includes(":")) return null;
  const [head, ...rest] = h.split("::");
  if (rest.length > 1) return null;
  const headGroups = head ? head.split(":") : [];
  const tailGroups = rest.length === 1 && rest[0] ? rest[0].split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  const groups = [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

/** IPv6 unique-local (fc00::/7) and link-local (fe80::/10). */
function isPrivateIPv6(hostname: string): boolean {
  const expanded = expandIPv6(hostname);
  if (!expanded) return false;
  const first = parseInt(expanded.slice(0, 4), 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

const PRIVATE_HOSTNAME_SUFFIXES = [".local", ".lan", ".home", ".internal", ".intranet", ".corp", ".home.arpa"];

export function isLoopbackHost(hostname: string): boolean {
  const h = stripBrackets(hostname).toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  return isLoopbackIPv4(h);
}

/**
 * True when the host is reachable only inside a private network —
 * something Google/Notion will never accept as an OAuth redirect target.
 * Loopback is deliberately excluded (handled as its own, allowed category).
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const h = stripBrackets(hostname).toLowerCase();
  if (isLoopbackHost(h)) return false;
  if (isPrivateIPv4(h) || isPrivateIPv6(h)) return true;
  return PRIVATE_HOSTNAME_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s));
}

export type RedirectUriCheck =
  | { ok: true }
  | { ok: false; reason: "private-network-host" | "http-not-loopback" };

/**
 * Checks whether an OAuth redirect URI will be accepted by providers that
 * require a public https target or a loopback http target (Google, Notion).
 */
export function checkRedirectUri(redirectUri: string): RedirectUriCheck {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    // Unparseable — fail open; the provider will surface its own error.
    return { ok: true };
  }
  const hostname = url.hostname;
  if (isPrivateNetworkHost(hostname)) return { ok: false, reason: "private-network-host" };
  if (url.protocol === "http:" && !isLoopbackHost(hostname)) return { ok: false, reason: "http-not-loopback" };
  return { ok: true };
}

const SERVICE_CZ: Record<OAuthService, string> = {
  google: "Google",
  slack: "Slack",
  mistral: "Mistral",
  notion: "Notion",
  github: "GitHub",
};

/**
 * Human-readable Czech explanation shown in the Hertz UI (as the OAuth
 * error card) when the flow cannot start because of a private-network
 * address. No unexplained jargon: "lokální síťová adresa" instead of
 * "private IP", "zabezpečené spojení" instead of bare "https".
 *
 * For Google the primary offer is "Přihlásit kódem — bez veřejné adresy"
 * (device flow: a code is shown, the user enters it at google.com/device,
 * the server address plays no role); the tunnel and the public domain are
 * offered only as marginal alternatives for the classic browser-based flow.
 * Notion has no device flow, so it keeps the tunnel / public domain pair
 * as the two options.
 */
export function localNetworkOAuthBlockedMessage(opts: { service: OAuthService; redirectUri: string }): string {
  const serviceCz = SERVICE_CZ[opts.service] ?? opts.service;
  const callbackPath = `/api/oauth/${opts.service}/callback`;
  const intro =
    `Přihlášení přes ${serviceCz} teď nejde spustit. Důvod je prostý: ${serviceCz} nepřijímá návratovou adresu z lokální sítě — ` +
    `tento Hertz běží na adrese, kterou ${serviceCz} pro přihlašování odmítá. Fungují jen veřejné adresy se zabezpečeným spojením (https) ` +
    `nebo adresa přímo na tomto počítači (localhost).\n\n`;
  if (opts.service === "google") {
    return (
      intro +
      `Nejjednodušší cesta — Přihlásit kódem (bez veřejné adresy):\n` +
      `Hertzi se ukáže krátký kód. Otevři na svém telefonu nebo počítači stránku google.com/device, kód tam zadej a přihlas se Googlem. ` +
      `Hotovo — adresa tohoto serveru při tom nehraje žádnou roli. ` +
      `Vyžaduje jen, aby správce v nastavení konektoru Google jednou zadal údaje klienta typu „TV“ (návod najde v Nastavení → Konektory → Google).\n\n` +
      `Klasické přihlášení přes prohlížeč je tu jen jako krajní možnost (vyber si jednu z nich):\n` +
      `1. SSH tunel: na svém počítači spusť příkaz\n` +
      `   ssh -L 4173:localhost:4173 uživatel@server\n` +
      `   pak v prohlížeči otevři http://localhost:4173 a v nastavení OAuth klienta u Googlu přidej návratovou adresu\n` +
      `   http://localhost:4173${callbackPath}\n` +
      `2. Veřejná adresa: zprovozni pro Hertz veřejnou adresu se zabezpečeným spojením (například přes Cloudflare Tunnel) ` +
      `a v nastavení OAuth klienta u Googlu přidej návratovou adresu\n` +
      `   https://vase-domena${callbackPath}`
    );
  }
  return (
    intro +
    `Co s tím (vyber si jednu možnost):\n` +
    `1. SSH tunel: na svém počítači spusť příkaz\n` +
    `   ssh -L 4173:localhost:4173 uživatel@server\n` +
    `   pak v prohlížeči otevři http://localhost:4173 a v nastavení OAuth klienta u ${serviceCz} přidej návratovou adresu\n` +
    `   http://localhost:4173${callbackPath}\n` +
    `2. Veřejná adresa: zprovozni pro Hertz veřejnou adresu se zabezpečeným spojením (například přes Cloudflare Tunnel) ` +
    `a v nastavení OAuth klienta u ${serviceCz} přidej návratovou adresu\n` +
    `   https://vase-domena${callbackPath}`
  );
}
