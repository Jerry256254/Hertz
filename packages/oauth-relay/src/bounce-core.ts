/**
 * Sdílené jádro bounce logiky — čistá funkce bez závislostí na node:http.
 *
 * Používají ho oba běhové adaptéry:
 *  - `src/bounce.ts`  (samostatný node:http server)
 *  - `api/bounce.ts`  (Vercel serverless function)
 *
 * Kontrakt /bounce:
 *  - ověří relay `state` (HMAC, TTL 10 minut, bezpečný target)
 *  - na instanci předá POUZE `code`, `error`, `error_description`
 *  - relay `state` se ověří, ale NEPŘEDÁVÁ (target už nese vnitřní state instance)
 *  - existující query v targetu se zachovává, včetně jeho vnitřního `state`
 */

import { verifyState, type VerifyFailureReason } from "./state.js";

/** Jediné query parametry, které relay smí předat dál na instanci.
 *  Relay `state` se ověřuje, ale nepředává — target už nese vnitřní state instance. */
const FORWARDED_PARAMS = ["code", "error", "error_description"] as const;

/**
 * Důvod zamítnutí požadavku. Slouží POUZE pro logování na straně serveru —
 * klientovi se důvod nikdy nevrací (ani v těle odpovědi).
 */
export type BounceFailureReason = "missing-state" | VerifyFailureReason;

export type BounceResult =
  | { status: 302; location: string; svc: "google" | "notion" }
  // 404 jádro samo nikdy nevrací — člen je v unii pro adaptéry,
  // které řeší routing cest samy (path-agnostické nasazení).
  | { status: 400 | 404 | 405; body: string; reason?: BounceFailureReason };

/**
 * Sestaví cílovou URL: vezme ověřený target a přidá povolené parametry
 * z příchozího query stringu. Existující query v targetu se zachová —
 * včetně vnitřního `state` instance, který relay nikdy nepřepisuje.
 */
export function buildRedirectUrl(target: string, params: URLSearchParams): string {
  const url = new URL(target);
  for (const name of FORWARDED_PARAMS) {
    const value = params.get(name);
    if (value !== null) {
      url.searchParams.set(name, value);
    }
  }
  return url.toString();
}

/**
 * Čisté vyhodnocení požadavku na /bounce.
 *
 * @param secret tajný klíč pro HMAC ověření state
 * @param method HTTP metoda — povoleny jsou GET a HEAD, ostatní dají 405
 * @param params parsované query parametry příchozího požadavku
 * @returns výsledek, který adaptér zapíše do HTTP odpovědi
 */
export function handleBounceRequest(
  secret: string,
  method: string,
  params: URLSearchParams,
): BounceResult {
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, body: "Metoda není povolena." };
  }

  const state = params.get("state");
  if (!state) {
    return {
      status: 400,
      body: "Neplatný nebo expirovaný požadavek.",
      reason: "missing-state",
    };
  }

  const verified = verifyState(state, secret);
  if (!verified.ok) {
    // Záměrně bez detailu důvodu v těle odpovědi — nic nesmí prozradit
    // autorizační kód ani strukturu state útočníkovi.
    return {
      status: 400,
      body: "Neplatný nebo expirovaný požadavek.",
      reason: verified.reason,
    };
  }

  return {
    status: 302,
    location: buildRedirectUrl(verified.payload.target, params),
    svc: verified.payload.svc,
  };
}
