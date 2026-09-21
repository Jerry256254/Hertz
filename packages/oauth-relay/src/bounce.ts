/**
 * HTTP handler pro OAuth relay bounce (node:http adaptér).
 *
 * Path routing (/, /healthz, /bounce, 404, 405) a logování zůstávají zde;
 * samotné vyhodnocení /bounce deleguje na sdílené jádro `bounce-core.ts`,
 * aby se logika neduplikovala s Vercel adaptérem (`api/bounce.ts`).
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
import { handleBounceRequest } from "./bounce-core.js";
import { createLogger, type RelayLogger } from "./logger.js";

// Zpětná kompatibilita: buildRedirectUrl žije v jádře, re-export pro staré importy.
export { buildRedirectUrl } from "./bounce-core.js";

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

    const result = handleBounceRequest(secret, method, params);
    if (result.status === 302) {
      logger.info(`302 bounce svc=${result.svc}`);
      res.writeHead(302, { Location: result.location, "Cache-Control": NO_STORE });
      res.end();
      return;
    }
    if (result.status === 400) {
      logger.warn(
        result.reason === "missing-state"
          ? "400 missing-state"
          : `400 invalid-state (${result.reason ?? "unknown"})`,
      );
      send(res, 400, result.body);
      return;
    }
    // Při tomto pořadí kontrol sem 405 z jádra nedojde (metoda je ověřena
    // výše) — větev je tu pro úplnost, kdyby se routing v budoucnu změnil.
    logger.warn(`${result.status} ${path}`);
    send(res, result.status, result.body);
  };
}
