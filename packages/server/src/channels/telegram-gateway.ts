import { and, eq } from "drizzle-orm";
import type { Logger } from "./types.js";

const API = "https://api.telegram.org";
const POLL_TIMEOUT_S = 25;

/**
 * Telegram gateway: plain long-polling against the Bot API — no SDK needed.
 * One poller per enabled telegram channel config; each inbound private/group
 * message is handed to onMessage with a reply callback bound to that chat.
 */
export class TelegramGateway {
  private offset = 0;
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly logger: Logger,
    private readonly onMessage: (ctx: { chatId: string; senderName: string; text: string; reply: (text: string) => Promise<void> }) => Promise<void>,
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(`${API}/bot${this.token}/getUpdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message"] }),
        });
        if (!res.ok) {
          // 409 = another poller running (two server instances); back off either way.
          await sleep(10_000);
          continue;
        }
        const body = (await res.json()) as {
          ok: boolean;
          result?: Array<{ update_id: number; message?: TelegramUpdateMessage }>;
        };
        for (const update of body.result ?? []) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          const text = msg?.text ?? msg?.caption;
          const chatId = msg?.chat?.id != null ? String(msg.chat.id) : undefined;
          if (!msg || !text || !chatId) continue;
          const senderName = msg.from?.first_name ?? msg.chat?.title ?? "Someone";
          try {
            await this.onMessage({
              chatId,
              senderName,
              text,
              reply: (replyText) => this.sendMessage(chatId, replyText),
            });
          } catch (err) {
            this.logger.warn((err as Error).message, "telegram handler failed");
          }
        }
      } catch (err) {
        if (!this.stopped) this.logger.warn((err as Error).message, "telegram poll failed");
        await sleep(5_000);
      }
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    // Telegram hard-caps messages at 4096 chars — split long reports.
    for (const chunk of chunkText(text, 3_800)) {
      const res = await fetch(`${API}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "" }),
      });
      if (!res.ok) throw new Error(`telegram sendMessage failed: ${res.status}`);
    }
  }

  async me(): Promise<{ username?: string }> {
    const res = await fetch(`${API}/bot${this.token}/getMe`);
    if (!res.ok) throw new Error(`telegram getMe failed: ${res.status}`);
    return ((await res.json()) as any).result ?? {};
  }
}

interface TelegramUpdateMessage {
  chat?: { id?: number; title?: string };
  from?: { first_name?: string };
  text?: string;
  caption?: string;
}

export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const cut = rest.lastIndexOf("\n", maxLen);
    const idx = cut > maxLen / 2 ? cut : maxLen;
    chunks.push(rest.slice(0, idx));
    rest = rest.slice(idx);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
