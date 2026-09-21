/**
 * HTTP handler pro OAuth relay bounce.
 *
 * Kontrakt:
 *  - GET /bounce?code=<code>&state=<state>  → 302 na target z ověřeného state
 *  - GET /bounce?error=…&error_description=…&state=<state> (uživatel zamítl souhlas)
 *      → 302 na target s error parametry (state se ověřuje stejně)
 *  - Při neúspěchu validace → 400 s prostou chybou, BEZ vypsání parametrů
 *  - GET /healthz → 200 "ok"
 *  - GET / → krátké info
 *
 * Relay `state` slouží pouze k ověření na relay (HMAC) a dál se NEPŘEDÁVÁ:
 * target URL už nese vlastní vnitřní state instance v `?state=` — přepsání
 * relay tokenem by callback rozbilo. Z providera se na instanci předávají
 * pouze parametry code, error a error_description. Vše ostatní se zahazuje.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyState } from "./state.js";
import { createLogger, type RelayLogger } from "./logger.js";

/** Jediné query parametry, které relay smí předat dál na instanci.
 *  Relay `state` se ověřuje, ale nepředává — target už nese vnitřní state instance. */
const FORWARDED_PARAMS = ["code", "error", "error_description"] as const;

const TEXT = { "Content-Type": "text/plain; charset=utf-8" };
const NO_STORE = "no-store, no-cache, must-revalidate";

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { ...TEXT, "Cache-Control": NO_STORE, ...headers });
  res.end(body);
}

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

function pathOf(rawUrl: string | undefined): string {
  const u = rawUrl ?? "/";
  const q = u.indexOf("?");
  return q === -1 ? u : u.slice(0, q);
}

const INFO_HTML = `<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><title>Hertz OAuth Relay</title></head>
<body style="font-family:sans-serif;max-width:40em;margin:3em auto;line-height:1.6">
<h1>Hertz OAuth Relay</h1>
<p>Minimalistický bounce server pro OAuth přihlašování. Google (a další provideři)
odmítají redirect URI na privátní IP, proto se autorizační kód nejprve doručí sem
a relay prohlížeč okamžitě přesměruje zpět na instanci Hertze.</p>
<ul>
<li><code>GET /bounce?code=…&amp;state=…</code> — přesměrování na instanci</li>
<li><code>GET /healthz</code> — health check pro load balancery</li>
</ul>
<p>Relay nikdy nevidí tokeny, neukládá kódy a neloguje query parametry.
Podrobnosti v <a href="https://github.com/Jerry256254/Hertz/blob/main/packages/oauth-relay/README.md">README</a>.</p>
</body></html>`;

export interface BounceHandlerOptions {
  logger?: RelayLogger;
}

export function createBounceHandler(secret: string, options: BounceHandlerOptions = {}) {
  const logger = options.logger ?? createLogger();

  return function handleBounce(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? "GET";
    const path = pathOf(req.url);

    // Do logu pouze metoda a cesta — nikdy query string (obsahuje code/state).
    logger.info(`${method} ${path}`);

    if (method !== "GET" && method !== "HEAD") {
      logger.warn(`405 ${path}`);
      send(res, 405, "Metoda není povolena.");
      return;
    }

    if (path === "/healthz") {
      send(res, 200, "ok");
      return;
    }

    if (path === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": NO_STORE,
      });
      res.end(INFO_HTML);
      return;
    }

    if (path !== "/bounce") {
      send(res, 404, "Nenalezeno.");
      return;
    }

    let params: URLSearchParams;
    try {
      params = new URL(req.url ?? "/bounce", "http://relay.invalid").searchParams;
    } catch {
      logger.warn("400 malformed-url");
      send(res, 400, "Neplatný požadavek.");
      return;
    }

    const state = params.get("state");
    if (!state) {
      logger.warn("400 missing-state");
      send(res, 400, "Neplatný nebo expirovaný požadavek.");
      return;
    }

    const verified = verifyState(state, secret);
    if (!verified.ok) {
      // Záměrně bez detailu důvodu a bez vypsání parametrů — nic nesmí
      // prozradit autorizační kód ani strukturu state útočníkovi.
      logger.warn(`400 invalid-state (${verified.reason})`);
      send(res, 400, "Neplatný nebo expirovaný požadavek.");
      return;
    }

    const location = buildRedirectUrl(verified.payload.target, params);
    logger.info(`302 bounce svc=${verified.payload.svc}`);
    res.writeHead(302, { Location: location, "Cache-Control": NO_STORE });
    res.end();
  };
}
