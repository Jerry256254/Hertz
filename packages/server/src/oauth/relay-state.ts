import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth relay (bounce) flow — packages/oauth-relay.
 *
 * Když Hertz běží na privátní IP, Google/Notion odmítnou jeho callback URL
 * jako redirect URI. Řešením je veřejný relay server: OAuth start pošle
 * prohlížeč na `<relay>/bounce` jako redirect_uri, poskytovatel se tam vrátí
 * s autorizačním kódem a relay prohlížeč přesměruje zpět na instanci
 * (tu uživatel otevírá přímo, takže bounce na privátní adresu funguje).
 *
 * Bezpečnost: relay musí poznat, že požadavek na /bounce opravdu vzešel
 * z této instance — proto je `state` pro poskytovatele podepsaný token
 * (kontrakt s relay workerem, dodržet přesně):
 *   v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(rawPayloadB64, secret))>
 * payload = { target, svc, iat, nonce }
 * Secret je env HERTZ_OAUTH_STATE_SECRET a MUSÍ být stejný jako
 * RELAY_STATE_SECRET na relay serveru.
 *
 * `target` je callback URL instance. Vnitřní podepsaný Hertz state
 * (služba, konektor, uživatel — viz signState v oauth-service.ts) neseme
 * v cílové URL jako parametr `?state=…`, aby callback endpoint po bounci
 * fungoval úplně beze změny: přijme code+state a kód vymění standardní
 * cestou. Relay při bounci předává dál jen `code` (plus případný `error`),
 * svůj vlastní state token dál neposílá.
 */

/** OAuth služby, které umí jet přes relay. */
export type RelayOAuthService = "google" | "notion";

/** Jak dlouho platí podepsaný relay state token (10 minut). */
export const RELAY_TTL_MS = 10 * 60 * 1000;

export interface RelayStatePayload {
  /** Callback URL instance, kam má relay prohlížeč po autorizaci vrátit (včetně vnitřního Hertz state v query). */
  target: string;
  /** Služba, pro kterou bounce probíhá. */
  svc: RelayOAuthService;
  /** Čas podpisu v milisekundách od epochy. */
  iat: number;
  /** Náhodný 16znakový hex řetězec proti replay útokům. */
  nonce: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Podepíše relay state token pro OAuth start přes bounce.
 * HMAC-SHA256 se počítá z base64url řetězce payloadu (ne z dekódovaného JSON).
 */
export function signRelayState(target: string, svc: RelayOAuthService, secret: string): string {
  const payload: RelayStatePayload = {
    target,
    svc,
    iat: Date.now(),
    nonce: randomBytes(8).toString("hex"),
  };
  const raw = base64url(JSON.stringify(payload));
  const sig = base64url(createHmac("sha256", secret).update(raw).digest());
  return `v1.${raw}.${sig}`;
}

/**
 * Ověří relay state token (stejný algoritmus používá relay server).
 * Vrací payload, nebo undefined při neplatném podpisu / formátu / expiraci.
 */
export function verifyRelayState(token: string, secret: string): RelayStatePayload | undefined {
  const [version, raw, sig] = token.split(".");
  if (version !== "v1" || !raw || !sig) return undefined;
  const expected = base64url(createHmac("sha256", secret).update(raw).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as RelayStatePayload;
    if (payload.svc !== "google" && payload.svc !== "notion") return undefined;
    if (typeof payload.target !== "string" || !payload.target) return undefined;
    if (typeof payload.iat !== "number" || Number.isNaN(payload.iat)) return undefined;
    if (Date.now() - payload.iat > RELAY_TTL_MS) return undefined;
    if (typeof payload.nonce !== "string" || !/^[0-9a-f]{16}$/.test(payload.nonce)) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

/**
 * Base URL OAuth relay z HERTZ_OAUTH_RELAY_URL (bez trailing slash),
 * nebo undefined když relay není nastavený — pak vše jede přímo jako dnes.
 */
export function oauthRelayBaseUrl(): string | undefined {
  const raw = process.env.HERTZ_OAUTH_RELAY_URL?.trim().replace(/\/+$/, "");
  return raw || undefined;
}

/**
 * Bounce URL relay — sem míří redirect_uri při OAuth startu přes relay.
 * Kontrakt: <HERTZ_OAUTH_RELAY_URL bez trailing slash>/bounce.
 */
export function oauthRelayBounceUrl(): string | undefined {
  const base = oauthRelayBaseUrl();
  return base ? `${base}/bounce` : undefined;
}
