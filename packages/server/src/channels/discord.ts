import WebSocket from "ws";
import type { ChannelCallbacks, ChannelDriver } from "./types.js";
import { chunkText } from "./types.js";

const REST = "https://discord.com/api/v10";
const LIMIT = 2000;

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
const INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);

interface GatewayEvent {
  op: number;
  t?: string;
  s?: number | null;
  d?: any;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; bot?: boolean; username: string };
}

/**
 * Discord gateway client (identify + heartbeat + resume) with REST sends.
 * Requires the MESSAGE CONTENT privileged intent, otherwise message bodies
 * arrive empty — surfaced loudly in the log, not silently.
 */
export class DiscordDriver implements ChannelDriver {
  private ws: WebSocket | undefined;
  private stopped = false;
  private sessionId: string | undefined;
  private resumeUrl: string | undefined;
  private seq: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private selfId = "";
  private warnedEmptyContent = false;

  constructor(private readonly token: string) {}

  private async rest<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${REST}${path}`, {
      method,
      headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "2") * 1000;
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10_000)));
      return this.rest(method, path, body);
    }
    if (!res.ok) throw new Error(`Discord ${method} ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  async verify(): Promise<string> {
    const me = await this.rest<{ id: string; username: string }> ("GET", "/users/@me");
    this.selfId = me.id;
    return `@${me.username}`;
  }

  async start(cb: ChannelCallbacks): Promise<void> {
    this.stopped = false;
    await this.verify().catch((err) => {
      throw new Error(`Discord token rejected: ${(err as Error).message}`);
    });
    void this.connectLoop(cb);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = undefined;
  }

  private async connectLoop(cb: ChannelCallbacks): Promise<void> {
    let backoffMs = 1_000;
    while (!this.stopped) {
      try {
        await this.connectOnce(cb);
        backoffMs = 1_000;
      } catch (err) {
        if (this.stopped) return;
        console.warn(`[hertz] discord gateway dropped: ${(err as Error).message} — reconnecting`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  private connectOnce(cb: ChannelCallbacks): Promise<void> {
    return new Promise((resolve, reject) => {
      const base = this.sessionId && this.resumeUrl ? this.resumeUrl : "wss://gateway.discord.gg";
      const ws = new WebSocket(`${base}/?v=10&encoding=json`);
      this.ws = ws;

      const cleanup = () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        if (this.ws === ws) this.ws = undefined;
      };

      ws.on("message", (raw) => {
        let event: GatewayEvent;
        try {
          event = JSON.parse(raw.toString()) as GatewayEvent;
        } catch {
          return;
        }
        if (typeof event.s === "number") this.seq = event.s;
        void this.handleEvent(cb, ws, event).catch((err) =>
          console.warn(`[hertz] discord event failed: ${(err as Error).message}`),
        );
      });

      ws.on("close", (code) => {
        cleanup();
        // 4014 = disallowed intents: retrying won't help.
        if (code === 4014) {
          console.error("[hertz] discord: disallowed intents — enable MESSAGE CONTENT intent in the Developer Portal");
        }
        // 4004/4010/4011/4012/4013 = fatal, drop resume state.
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
          this.sessionId = undefined;
          this.resumeUrl = undefined;
          this.seq = null;
        }
        if (this.stopped) resolve();
        else reject(new Error(`gateway closed (${code})`));
      });

      ws.on("error", () => {
        // 'close' follows and drives the reconnect; nothing to do here.
      });
    });
  }

  private send(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  private async handleEvent(cb: ChannelCallbacks, ws: WebSocket, event: GatewayEvent): Promise<void> {
    switch (event.op) {
      case 10: {
        // Hello — heartbeat + identify/resume.
        const interval = Math.max(1000, Number(event.d?.heartbeat_interval ?? 41250));
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this.send(ws, { op: 1, d: this.seq }), interval);
        if (this.sessionId) {
          this.send(ws, { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.send(ws, {
            op: 2,
            d: {
              token: this.token,
              intents: INTENTS,
              properties: { os: "linux", browser: "hertz", device: "hertz" },
            },
          });
        }
        return;
      }
      case 11:
        return; // heartbeat ack
      case 7:
        ws.close();
        return; // asked to reconnect
      case 9:
        // Invalid session: wait, then identify fresh.
        await new Promise((r) => setTimeout(r, 2000));
        this.sessionId = undefined;
        this.resumeUrl = undefined;
        this.send(ws, {
          op: 2,
          d: { token: this.token, intents: INTENTS, properties: { os: "linux", browser: "hertz", device: "hertz" } },
        });
        return;
      case 0:
        break; // dispatch — handled below
      default:
        return;
    }

    if (event.t === "READY") {
      this.sessionId = event.d?.session_id;
      this.resumeUrl = event.d?.resume_gateway_url;
      this.selfId = event.d?.user?.id ?? this.selfId;
      return;
    }

    if (event.t === "MESSAGE_CREATE") {
      const msg = event.d as DiscordMessage;
      if (!msg || msg.author?.bot || msg.author?.id === this.selfId) return;
      if (!msg.content?.trim()) {
        if (!this.warnedEmptyContent) {
          this.warnedEmptyContent = true;
          console.warn("[hertz] discord: empty message content — enable the MESSAGE CONTENT privileged intent");
        }
        return;
      }
      await cb.onMessage({
        externalChatId: `discord:${msg.channel_id}`,
        senderLabel: `@${msg.author.username}`,
        text: msg.content.trim(),
      });
    }
  }

  private channelId(externalChatId: string): string {
    return externalChatId.replace(/^discord:/, "");
  }

  async sendText(externalChatId: string, text: string): Promise<void> {
    const channelId = this.channelId(externalChatId);
    await this.rest("POST", `/channels/${channelId}/typing`).catch(() => {});
    for (const chunk of chunkText(text, LIMIT)) {
      await this.rest("POST", `/channels/${channelId}/messages`, { content: chunk });
    }
  }

  async sendApproval(externalChatId: string, approvalId: string, summary: string, detail: string | null): Promise<void> {
    // Buttons would need an application id + interaction flow; text commands
    // (/approve <id>, /reject <id>) decide instead — same verdict, less setup.
    const lines = [`🔐 **Approval needed**`, ``, summary];
    if (detail?.trim()) lines.push(``, detail.trim().slice(0, 1500));
    lines.push(``, `Reply with \`/approve ${approvalId}\` or \`/reject ${approvalId}\`.`);
    await this.sendText(externalChatId, lines.join("\n"));
  }
}
