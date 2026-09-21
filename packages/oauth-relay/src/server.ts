import { createServer, type Server } from "node:http";
import { createBounceHandler } from "./bounce.js";

/** Vytvoří HTTP server relay bez navázání na port (vhodné i pro testy). */
export function createRelayServer(secret: string): Server {
  return createServer(createBounceHandler(secret));
}
