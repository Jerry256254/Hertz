import crypto from "node:crypto";

/**
 * Short-lived signed tokens for delegating access to a single agent's screen
 * (take-over links). HMAC-SHA256 under the master key; carries only agentId +
 * expiry — no secrets, single purpose, expires fast.
 */
export interface ScreenTokenPayload {
  agentId: string;
  exp: number; // epoch ms
  /** Optional single-use nonce recorded by the caller. */
  nonce?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signScreenToken(masterKey: Buffer, payload: ScreenTokenPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(crypto.createHmac("sha256", masterKey).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyScreenToken(masterKey: Buffer, token: string, agentId: string): boolean {
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  const expected = b64url(crypto.createHmac("sha256", masterKey).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ScreenTokenPayload;
    if (payload.agentId !== agentId) return false;
    if (payload.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}
