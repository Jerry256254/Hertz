/**
 * Vercel serverless function pro OAuth relay bounce.
 *
 * Tenký adaptér: Vercel routuje /bounce na tuto funkci (viz vercel.json),
 * veškerou rozhodovací logiku drží sdílené jádro `src/bounce-core.ts`.
 * Typováno pouze přes node:http — žádná závislost na @vercel/node.
 *
 * Secret čte z process.env.RELAY_STATE_SECRET (min. 16 znaků).
 * Query parametry se NIKDY nelogují (ani Location s autorizačním kódem).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleBounceRequest } from "../src/bounce-core.js";
import { createLogger } from "../src/logger.js";
import { MIN_SECRET_LENGTH } from "../src/state.js";

const TEXT_PLAIN = "text/plain; charset=utf-8";
const NO_STORE = "no-store, no-cache, must-revalidate";

function pathOf(rawUrl: string | undefined): string {
  const u = rawUrl ?? "/";
  const q = u.indexOf("?");
  return q === -1 ? u : u.slice(0, q);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": TEXT_PLAIN, "Cache-Control": NO_STORE });
  res.end(body);
}

/**
 * Vercel Node.js function handler. Path-agnostický — Vercel sem routuje /bounce,
 * proto se cesta nekontroluje a do logu jde jen metoda s cestou bez query.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const logger = createLogger();
  const method = req.method ?? "GET";

  // Do logu pouze metoda a cesta bez query — query nese code/state.
  logger.info(`${method} ${pathOf(req.url)}`);

  const secret = process.env.RELAY_STATE_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    // Záměrně bez detailů: klient ani log nesmí poznat, co přesně chybí.
    logger.error("500 chyba-konfigurace");
    sendText(res, 500, "Chyba konfigurace serveru.");
    return;
  }

  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? "/", "http://relay.invalid").searchParams;
  } catch {
    logger.warn("400 malformed-url");
    sendText(res, 400, "Neplatný požadavek.");
    return;
  }

  const result = handleBounceRequest(secret, method, params);
  if (result.status === 302) {
    // Location obsahuje autorizační kód — do logu nikdy, jen holý fakt bounce.
    logger.info("302 bounce");
    res.writeHead(302, { Location: result.location, "Cache-Control": NO_STORE });
    res.end();
    return;
  }

  logger.warn(`${result.status} bounce (${result.reason ?? "neznamy-duvod"})`);
  sendText(res, result.status, result.body);
}
