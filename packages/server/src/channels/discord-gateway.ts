import WebSocket from "ws";
import type { Logger } from "./types.js";

const API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

interface GatewayPayload {
  op: number; // 0 dispatch, 1 heartbeat, 2 identify, 10 hello, 11 heartbeat ack
  t?: string;
  s?: number | null;
  d?: any;
}

/**
 * Minimal Discord gateway client — just enough for a bot that reads
 * MESSAGE_CREATE and sends replies over REST, with zero SDK dependencies:
 * connect → hello → identify → heartbeat loop → dispatch handling.
 * Reconnects with backoff; resume (op 6) is intentionally skipped in favor of
 * a fresh identify, since losing a few messages during a reconnect is fine
 * for this use case.
 */
export class DiscordGateway {
  private ws?: WebSocket;
  private stopped = false;
  private seq: number | null = null;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly token: string,
    private readonly logger: Logger,
    private readonly onMessage: (ctx: { channelId: string; guildId?: string; senderName: string; text: string; reply: (text: string) => Promise<void> }) => Promise<void>,
  ) {}

  stop(): void {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    this.ws?.close();
  }

  async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await new Promise<void>((resolve) => this.connectOnce(resolve));
      } catch (err) {
        if (!this.stopped) this.logger.warn((err as Error).message, "discord gateway error");
      }
      if (!this.stopped) await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  private connectOnce(onClose: () => void): void {
    const ws = new WebSocket(GATEWAY_URL);
    this.ws = ws;

    ws.on("open", () => this.logger.info?.("discord gateway connected"));
    ws.on("close", () => {
      clearInterval(this.heartbeatTimer);
      onClose();
    });
    ws.on("error", () => {
      /* close handler follows */
    });
    ws.on("message", (raw: Buffer) => {
      const payload = JSON.parse(raw.toString()) as GatewayPayload;
      if (payload.s != null) this.seq = payload.s;
      switch (payload.op) {
        case 10: { // Hello
          const interval = payload.d?.heartbeat_interval ?? 41_250;
          this.heartbeatTimer = setInterval(() => this.send(ws, { op: 1, d: this.seq }), interval);
          this.send(ws, {
            op: 2,
            d: {
              token: this.token,
              intents: 33280 | (1 << 15), // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
              properties: { os: "linux", browser: "hertz", device: "hertz" },
            },
          });
          break;
        }
        case 0: // Dispatch
          if (payload.t === "MESSAGE_CREATE" && payload.d && !payload.d.author?.bot) {
            const content = String(payload.d.content ?? "");
            const channelId = String(payload.d.channel_id ?? "");
            if (!content || !channelId) break;
            const senderName = payload.d.member?.nick ?? payload.d.author?.global_name ?? payload.d.author?.username ?? "Someone";
            void this.onMessage({
              channelId,
              guildId: payload.d.guild_id ? String(payload.d.guild_id) : undefined,
              senderName,
              text: content,
              reply: (replyText) => this.sendMessage(channelId, replyText),
            }).catch((err) => this.logger.warn((err as Error).message, "discord handler failed"));
          }
          break;
        default:
          break;
      }
    });
  }

  private send(ws: WebSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* connection is dying; the close/reconnect path handles it */
    }
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    for (const chunk of chunkMessage(text, 1_900)) {
      const res = await fetch(`${API}/channels/${channelId}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: chunk }),
      });
      if (!res.ok) throw new Error(`discord sendMessage failed: ${res.status}`);
    }
  }
}

export function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut <= maxLen / 2) cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= maxLen / 2) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}
