/**
 * Vstupní bod oauth-relay. Čte konfiguraci z prostředí a startuje HTTP server.
 *
 * Povinné:  RELAY_STATE_SECRET — tajný klíč pro HMAC podpis state (min. 16 znaků).
 *           Bez něj server odmítne startovat.
 * Volitelné: RELAY_PORT (výchozí 8090), RELAY_HOST (výchozí 0.0.0.0).
 */
import { createRelayServer } from "./server.js";
import { MIN_SECRET_LENGTH } from "./state.js";
import { createLogger } from "./logger.js";

const logger = createLogger();

const secret = process.env.RELAY_STATE_SECRET;
if (!secret || secret.length < MIN_SECRET_LENGTH) {
  logger.error(
    "CHYBA: proměnná prostředí RELAY_STATE_SECRET není nastavena " +
      `(nebo je kratší než ${MIN_SECRET_LENGTH} znaků). ` +
      "Vygeneruj ji příkazem: openssl rand -hex 32",
  );
  process.exit(1);
}

const portRaw = process.env.RELAY_PORT ?? "8090";
const port = Number.parseInt(portRaw, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  logger.error(`CHYBA: neplatný RELAY_PORT="${portRaw}".`);
  process.exit(1);
}

const host = process.env.RELAY_HOST ?? "0.0.0.0";

const server = createRelayServer(secret);
server.listen(port, host, () => {
  logger.info(`oauth-relay naslouchá na ${host}:${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
