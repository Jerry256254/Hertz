/**
 * Podepisování a ověřování `state` parametru pro OAuth relay bounce.
 *
 * Formát: `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(rawPayloadB64, secret))>`
 *
 * Payload: `{ target, svc, iat, nonce }`
 *  - target: callback URL instance Hertze (např. http://192.168.100.161:4173/api/oauth/google/callback)
 *  - svc:    "google" | "notion"
 *  - iat:    čas vytvoření v epoch ms
 *  - nonce:  16 hex znaků
 *
 * Relay nikdy nevidí tokeny — pouze přesměruje prohlížeč zpět na instanci.
 * Autorizační kód si s providerem vymění instance svým vlastním client secretem.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const STATE_VERSION = "v1";

/** Maximální stáří state v ms (10 minut). */
export const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/** Tolerance pro hodiny v budoucnosti (60 s). */
export const FUTURE_SKEW_MS = 60 * 1000;

/** Minimální délka RELAY_STATE_SECRET v znacích. */
export const MIN_SECRET_LENGTH = 16;

export interface BouncePayload {
  target: string;
  svc: "google" | "notion";
  iat: number;
  nonce: string;
}

const ALLOWED_SERVICES: ReadonlySet<string> = new Set(["google", "notion"]);

function b64urlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/** Vygeneruje náhodný nonce (16 hex znaků). */
export function createNonce(): string {
  return randomBytes(8).toString("hex");
}

/** Podepíše payload a vrátí state řetězec pro authorize URL. */
export function signState(payload: BouncePayload, secret: string): string {
  const raw = b64urlEncode(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(raw).digest();
  return `${STATE_VERSION}.${raw}.${b64urlEncode(mac)}`;
}

export type VerifyFailureReason =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "bad_target"
  | "bad_service";

export type VerifyResult =
  | { ok: true; payload: BouncePayload }
  | { ok: false; reason: VerifyFailureReason };

/**
 * Ověří state: formát, HMAC (timing-safe), stáří, službu a cílovou URL.
 * Při jakékoli pochybnosti vrací `{ ok: false }` — nikdy nevyhazuje.
 */
export function verifyState(
  state: string,
  secret: string,
  now: number = Date.now(),
): VerifyResult {
  const parts = state.split(".");
  if (parts.length !== 3 || parts[0] !== STATE_VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }
  const raw = parts[1] as string;
  const macB64 = parts[2] as string;

  try {
    const expected = createHmac("sha256", secret).update(raw).digest();
    const provided = b64urlDecode(macB64);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(raw).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "malformed" };
  }
  const p = payload as Record<string, unknown>;

  if (typeof p.svc !== "string" || !ALLOWED_SERVICES.has(p.svc)) {
    return { ok: false, reason: "bad_service" };
  }
  if (typeof p.iat !== "number" || !Number.isFinite(p.iat)) {
    return { ok: false, reason: "expired" };
  }
  if (p.iat > now + FUTURE_SKEW_MS || now - p.iat > STATE_MAX_AGE_MS) {
    return { ok: false, reason: "expired" };
  }
  if (typeof p.nonce !== "string" || !/^[0-9a-f]{16}$/i.test(p.nonce)) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof p.target !== "string" || !isSafeTarget(p.target)) {
    return { ok: false, reason: "bad_target" };
  }

  return {
    ok: true,
    payload: {
      target: p.target,
      svc: p.svc as "google" | "notion",
      iat: p.iat,
      nonce: p.nonce,
    },
  };
}

/**
 * Open-redirect ochrana: povolí pouze absolutní http(s) URL bez mezer a
 * řídicích znaků. Privátní IP jsou záměrně povolené — právě na ně relay
 * přesměrovává (instance běží na privátní síti).
 */
export function isSafeTarget(target: string): boolean {
  if (target.length === 0 || target.length > 2048) return false;
  if (/[\s\u007f-\u009f]/.test(target)) return false;
  if (target !== target.trim()) return false;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false; // relativní URL, "//evil.com", nesmysl, ...
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  return true;
}
