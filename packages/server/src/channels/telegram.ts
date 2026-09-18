import type { ChannelCallbacks, ChannelDriver } from "./types.js";
import { chunkText } from "./types.js";

const API = "https://api.telegram.org/bot";
const LIMIT = 4096;

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

function senderLabel(user: TgUser | undefined): string {
  if (!user) return "someone";
  if (user.username) return `@${user.username}`;
  return user.first_name ?? `user ${user.id}`;
}

/** Minimal Telegram Bot API client over long-polling — no extra dependencies. */
export class TelegramDriver implements ChannelDriver {
  private offset = 0;
  private stopped = false;
  private pollPromise: Promise<void> | undefined;

  constructor(private readonly token: string) {}

  private async api<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API}${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
    return json.result as T;
  }

  async verify(): Promise<string> {
    const me = await this.api<TgUser & { username?: string }>("getMe", {});
    return me.username ? `@${me.username}` : `bot ${me.id}`;
  }

  async start(cb: ChannelCallbacks): Promise<void> {
    this.stopped = false;
    // Drop backlog from before this boot — answering week-old messages is never right.
    await this.api("deleteWebhook", { drop_pending_updates: true }).catch(() => {});
    this.pollPromise = this.pollLoop(cb);
  }

  stop(): void {
    this.stopped = true;
  }

  private async pollLoop(cb: ChannelCallbacks): Promise<void> {
    let backoffMs = 1_000;
    while (!this.stopped) {
      try {
        const updates = await this.api<TgUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 50,
          allowed_updates: ["message", "edited_message", "callback_query"],
        });
        backoffMs = 1_000;
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(cb, update).catch((err) =>
            console.warn(`[hertz] telegram update failed: ${(err as Error).message}`),
          );
        }
      } catch (err) {
        if (this.stopped) return;
        // 401 = token revoked mid-run: stay down until reload rather than spinning.
        if (/401|Unauthorized/i.test((err as Error).message)) {
          console.error("[hertz] telegram token rejected (401) — disabling channel until reconfigured");
          return;
        }
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  private async handleUpdate(cb: ChannelCallbacks, update: TgUpdate): Promise<void> {
    const query = update.callback_query;
    if (query?.data && query.message) {
      const match = /^(approve|reject):([A-Za-z0-9_-]+)$/.exec(query.data);
      if (match) {
        await this.api("answerCallbackQuery", {
          callback_query_id: query.id,
          text: match[1] === "approve" ? "Approved" : "Rejected",
        }).catch(() => {});
        await cb.onDecision(`telegram:${query.message.chat.id}`, match[2]!, match[1] as "approved" | "rejected");
      }
      return;
    }

    const msg = update.message ?? update.edited_message;
    const text = msg?.text ?? msg?.caption;
    if (!msg || !text?.trim()) return;
    await cb.onMessage({
      externalChatId: `telegram:${msg.chat.id}`,
      senderLabel: senderLabel(msg.from),
      text: text.trim(),
    });
  }

  private chatId(externalChatId: string): string {
    return externalChatId.replace(/^telegram:/, "");
  }

  async sendText(externalChatId: string, text: string): Promise<void> {
    for (const chunk of chunkText(text, LIMIT)) {
      await this.api("sendMessage", { chat_id: this.chatId(externalChatId), text: chunk });
    }
  }

  async sendApproval(externalChatId: string, approvalId: string, summary: string, detail: string | null): Promise<void> {
    const lines = [`🔐 Approval needed`, ``, summary];
    if (detail?.trim()) lines.push(``, detail.trim().slice(0, 3000));
    for (const chunk of chunkText(lines.join("\n"), LIMIT)) {
      await this.api("sendMessage", {
        chat_id: this.chatId(externalChatId),
        text: chunk,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `approve:${approvalId}` },
              { text: "❌ Reject", callback_data: `reject:${approvalId}` },
            ],
          ],
        },
      });
    }
  }
}
