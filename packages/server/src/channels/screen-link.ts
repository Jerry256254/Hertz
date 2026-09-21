import os from "node:os";
import { signScreenToken } from "../secrets/screen-token.js";

const TOKEN_TTL_MS = 6 * 3600_000; // screen links live max 6h

function lanIp(): string | null {
  return (
    Object.values(os.networkInterfaces())
      .flat()
      .find((n) => n?.family === "IPv4" && !n.internal)?.address ?? null
  );
}

/**
 * One-click signed link to the agent's live screen (/screen/:agentId?t=…),
 * verified by the token-authenticated viewer in routes/screen.ts. Same shape
 * as the link the request_takeover tool hands out — anyone with the link can
 * watch/control the desktop until it expires, no Hertz login needed.
 * Returns null when the server's LAN address can't be determined.
 */
export function screenLinkFor(masterKey: Buffer, agentId: string): string | null {
  const ip = lanIp();
  if (!ip) return null;
  const port = Number(process.env.HERTZ_PORT ?? 4173);
  const token = signScreenToken(masterKey, { agentId, exp: Date.now() + TOKEN_TTL_MS });
  return `http://${ip}:${port}/screen/${agentId}?t=${token}`;
}
