import type { ChannelCallbacks, ChannelDriver, ChannelStartOptions, OutboundStream } from "./types.js";
import { chunkTelegramHtml, markdownToTelegramHtml, stripTelegramHtml } from "./telegram-format.js";

const API = "https://api.telegram.org/bot";
const LIMIT = 4096;
/**
 * Streamed preview keeps the tail of the draft — the newest text is what the
 * user watches while the agent works. Headroom below 4096 keeps the final
 * formatting (entities) intact.
 */
const STREAM_LIMIT = 3900;

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

export interface TelegramDriverOptions {
  /** Minimum gap between streamed editMessageText calls. Default 1000. */
  editThrottleMs?: number;
  /** Minimum gap between sendChatAction calls per chat. Default 2000. */
  typingCooldownMs?: number;
  /** Re-arm cadence of the typing bubble while a stream is open. Default 5000. */
  typingRefreshMs?: number;
  /** How many recent update/message ids are remembered for dedup. Default 500. */
  seenCacheSize?: number;
}

function senderLabel(user: TgUser | undefined): string {
  if (!user) return "someone";
  if (user.username) return `@${user.username}`;
  return user.first_name ?? `user ${user.id}`;
}

/** Draft Markdown → stream-safe HTML: tail-kept so long replies stay under the API limit. */
function renderStreamHtml(markdown: string): string {
  const html = markdownToTelegramHtml(markdown);
  if (html.length <= STREAM_LIMIT) return html;
  return "…\n" + html.slice(-STREAM_LIMIT);
}

/**
 * One live-updating Telegram message. Edits are throttled (Telegram allows
 * roughly one edit per second per message before it starts complaining) and
 * the typing bubble is re-armed on a timer — Telegram clears it whenever a
 * message lands, so without re-arming the user sees silence after each edit.
 */
class TelegramOutboundStream implements OutboundStream {
  private lastSentHtml: string | null = null;
  private pendingHtml: string | null = null;
  private lastEditAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private typingTimer: NodeJS.Timeout | null = null;
  /** Serializes editMessageText calls so they never overlap. */
  private editChain: Promise<void> = Promise.resolve();
  private closed = false;
  onClose: (() => void) | null = null;

  constructor(
    private readonly driver: TelegramDriver,
    private readonly externalChatId: string,
    private readonly chatId: string,
    private readonly messageId: number,
    private readonly opts: Required<TelegramDriverOptions>,
  ) {}

  async start(initialText: string): Promise<void> {
    await this.driver.typing(this.externalChatId).catch(() => {});
    this.typingTimer = setInterval(() => {
      void this.driver.typing(this.externalChatId).catch(() => {});
    }, this.opts.typingRefreshMs);
    this.typingTimer.unref?.();
    // Blank initial text: the "…" placeholder from beginStream is already
    // correct — never edit a message down to empty text (Telegram rejects it).
    if (initialText.trim()) await this.update(initialText);
  }

  async update(text: string): Promise<void> {
    if (this.closed) return;
    const html = renderStreamHtml(text);
    if (html === this.lastSentHtml) {
      this.pendingHtml = null;
      return;
    }
    this.pendingHtml = html;
    const wait = this.opts.editThrottleMs - (Date.now() - this.lastEditAt);
    if (wait <= 0) {
      await this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => {});
      }, wait);
      this.timer.unref?.();
    }
  }

  private async flush(): Promise<void> {
    if (this.closed || this.pendingHtml === null) return;
    const html = this.pendingHtml;
    this.pendingHtml = null;
    this.lastEditAt = Date.now();
    this.editChain = this.editChain.then(() => this.driver.editStreamMessage(this.chatId, this.messageId, html));
    await this.editChain;
    this.lastSentHtml = html;
    // Telegram clears the typing bubble when a message lands — re-arm it.
    await this.driver.typing(this.externalChatId).catch(() => {});
  }

  async finish(finalText: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    // Drain any throttled edit first so the final render never loses the tail.
    await this.editChain.catch(() => {});
    if (!finalText.trim()) {
      await this.driver.deleteStreamMessage(this.chatId, this.messageId);
    } else {
      // Keep the whole reply: first chunk edits the placeholder in place,
      // the rest follow as new messages (Telegram caps one message at 4096).
      // NB: full render, NOT the tail-keeping renderStreamHtml used for live
      // edits — the final message must not lose the head of the reply.
      const chunks = chunkTelegramHtml(markdownToTelegramHtml(finalText), LIMIT);
      const first = chunks[0] ?? "";
      if (first !== this.lastSentHtml) {
        await this.driver.editStreamMessage(this.chatId, this.messageId, first).catch(() => {});
      }
      for (const chunk of chunks.slice(1)) {
        await this.driver.sendHtmlChunk(this.externalChatId, chunk).catch(() => {});
      }
    }
    this.onClose?.();
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.pendingHtml = null;
    await this.editChain.catch(() => {});
    await this.driver.deleteStreamMessage(this.chatId, this.messageId);
    this.onClose?.();
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.timer = null;
    this.typingTimer = null;
  }
}

/** Minimal Telegram Bot API client over long-polling — no extra dependencies. */
export class TelegramDriver implements ChannelDriver {
  private offset = 0;
  private stopped = false;
  /** Bumped on every start(): a poll loop from an older generation exits on its own. */
  private generation = 0;
  private pollPromise: Promise<void> | undefined;
  private callbacks: ChannelCallbacks | undefined;
  private readonly opts: Required<TelegramDriverOptions>;
  /** Bounded FIFO of recently seen update ids — getUpdates may redeliver. */
  private seenUpdates: number[] = [];
  private seenUpdateSet = new Set<number>();
  /** Bounded FIFO of chat:message keys — a second line of defense for redelivery. */
  private seenMessages: string[] = [];
  private seenMessageSet = new Set<string>();
  private lastTypingAt = new Map<string, number>();
  private activeStreams = new Map<string, TelegramOutboundStream>();

  constructor(
    private readonly token: string,
    options?: TelegramDriverOptions,
  ) {
    this.opts = {
      editThrottleMs: options?.editThrottleMs ?? 1000,
      typingCooldownMs: options?.typingCooldownMs ?? 2000,
      typingRefreshMs: options?.typingRefreshMs ?? 5000,
      seenCacheSize: options?.seenCacheSize ?? 500,
    };
  }

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

  async start(cb: ChannelCallbacks, opts?: ChannelStartOptions): Promise<void> {
    const generation = ++this.generation;
    this.stopped = false;
    this.callbacks = cb;
    if (opts?.dropBacklog !== false) {
      // Drop backlog from before this boot — answering week-old messages is never right.
      await this.api("deleteWebhook", { drop_pending_updates: true }).catch(() => {});
    }
    this.pollPromise = this.pollLoop(cb, generation);
  }

  /**
   * Restart the inbound stream (e.g. after /restart) without dropping the
   * backlog. Safe to call from inside the poll loop itself (a command
   * handler): the old loop notices the generation change and exits on its
   * own once the in-flight update finishes — never awaited here, so no
   * self-deadlock.
   */
  async restart(opts?: ChannelStartOptions): Promise<void> {
    const cb = this.callbacks;
    // Streams belong to the old run — retire them so the new loop starts clean.
    for (const stream of this.activeStreams.values()) {
      await stream.abort().catch(() => {});
    }
    this.activeStreams.clear();
    if (cb) await this.start(cb, { dropBacklog: false, ...opts });
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    for (const stream of this.activeStreams.values()) {
      void stream.abort().catch(() => {});
    }
    this.activeStreams.clear();
  }

  /** True when the long-poll loop is currently up. */
  isPolling(): boolean {
    return !this.stopped;
  }

  private rememberUpdate(updateId: number): boolean {
    if (this.seenUpdateSet.has(updateId)) return false;
    this.seenUpdateSet.add(updateId);
    this.seenUpdates.push(updateId);
    while (this.seenUpdates.length > this.opts.seenCacheSize) {
      this.seenUpdateSet.delete(this.seenUpdates.shift()!);
    }
    return true;
  }

  private rememberMessage(chatId: number, messageId: number): boolean {
    const key = `${chatId}:${messageId}`;
    if (this.seenMessageSet.has(key)) return false;
    this.seenMessageSet.add(key);
    this.seenMessages.push(key);
    while (this.seenMessages.length > this.opts.seenCacheSize) {
      this.seenMessageSet.delete(this.seenMessages.shift()!);
    }
    return true;
  }

  private async pollLoop(cb: ChannelCallbacks, generation: number): Promise<void> {
    let backoffMs = 1_000;
    while (!this.stopped && this.generation === generation) {
      try {
        const updates = await this.api<TgUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 50,
          allowed_updates: ["message", "edited_message", "callback_query"],
        });
        backoffMs = 1_000;
        for (const update of updates) {
          // A restart from inside a command handler bumps the generation —
          // stop draining this stale batch, the new loop owns the stream now.
          if (this.generation !== generation) return;
          this.offset = Math.max(this.offset, update.update_id + 1);
          if (!this.rememberUpdate(update.update_id)) continue;
          await this.handleUpdate(cb, update).catch((err) =>
            console.warn(`[hertz] telegram update failed: ${(err as Error).message}`),
          );
        }
      } catch (err) {
        if (this.stopped || this.generation !== generation) return;
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
    if (query?.data) {
      await this.handleCallbackQuery(cb, query).catch((err) =>
        console.warn(`[hertz] telegram callback failed: ${(err as Error).message}`),
      );
      return;
    }

    const msg = update.message ?? update.edited_message;
    const text = msg?.text ?? msg?.caption;
    if (!msg || !text?.trim()) return;
    if (!this.rememberMessage(msg.chat.id, msg.message_id)) return;
    await cb.onMessage({
      externalChatId: `telegram:${msg.chat.id}`,
      senderLabel: senderLabel(msg.from),
      senderId: msg.from ? String(msg.from.id) : "",
      text: text.trim(),
    });
  }

  private async handleCallbackQuery(cb: ChannelCallbacks, query: TgCallbackQuery): Promise<void> {
    const data = query.data!;
    const decision = /^(approve|reject):([A-Za-z0-9_-]+)$/.exec(data);
    if (decision) {
      const verdict = decision[1] === "approve" ? ("approved" as const) : ("rejected" as const);
      await this.api("answerCallbackQuery", {
        callback_query_id: query.id,
        text: verdict === "approved" ? "Schváleno" : "Zamítnuto",
      }).catch(() => {});
      if (query.message) {
        await cb.onDecision(`telegram:${query.message.chat.id}`, decision[2]!, verdict);
      }
      return;
    }
    // Inline pickers from bot commands: tgcmd:<action>:<payload>
    const cmd = /^tgcmd:([a-z]+):([A-Za-z0-9_-]+)$/.exec(data);
    if (cmd && query.message) {
      await this.api("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
      if (cb.onCommandCallback) {
        await cb.onCommandCallback(`telegram:${query.message.chat.id}`, cmd[1]!, cmd[2]!, senderLabel(query.from));
      }
      return;
    }
    // Unknown button — at least dismiss the spinner.
    await this.api("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
  }

  private chatId(externalChatId: string): string {
    return externalChatId.replace(/^telegram:/, "");
  }

  /** Agent replies are Markdown — convert to Telegram HTML so formatting actually renders. */
  private async sendFormatted(externalChatId: string, markdown: string, extra?: Record<string, unknown>): Promise<void> {
    const html = markdownToTelegramHtml(markdown);
    for (const chunk of chunkTelegramHtml(html, LIMIT)) {
      try {
        await this.api("sendMessage", { chat_id: this.chatId(externalChatId), text: chunk, parse_mode: "HTML", ...extra });
      } catch (err) {
        // Telegram rejected the markup (rare — unbalanced entities after an
        // odd chunk edge): retry the same chunk as plain text, never fail loud.
        if (/can't parse entities|parse entities/i.test((err as Error).message)) {
          await this.api("sendMessage", { chat_id: this.chatId(externalChatId), text: stripTelegramHtml(chunk), ...extra });
        } else {
          throw err;
        }
      }
    }
  }

  async sendText(externalChatId: string, text: string): Promise<void> {
    await this.sendFormatted(externalChatId, text);
  }

  /** Markdown text with inline callback buttons (command pickers, confirmations). */
  async sendButtons(
    externalChatId: string,
    markdown: string,
    buttons: Array<Array<{ label: string; data: string }>>,
  ): Promise<void> {
    await this.sendFormatted(externalChatId, markdown, {
      reply_markup: {
        inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))),
      },
    });
  }

  async sendApproval(externalChatId: string, approvalId: string, summary: string, detail: string | null): Promise<void> {
    const lines = [`Je potřeba schválení`, ``, summary];
    if (detail?.trim()) lines.push(``, detail.trim().slice(0, 3000));
    await this.sendFormatted(externalChatId, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Schválit", callback_data: `approve:${approvalId}` },
            { text: "Zamítnout", callback_data: `reject:${approvalId}` },
          ],
        ],
      },
    });
  }

  /** "is typing…" with a per-chat cooldown so bursts of events don't spam the API. */
  async typing(externalChatId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastTypingAt.get(externalChatId) ?? 0;
    if (now - last < this.opts.typingCooldownMs) return;
    this.lastTypingAt.set(externalChatId, now);
    await this.api("sendChatAction", { chat_id: this.chatId(externalChatId), action: "typing" }).catch(() => {});
  }

  /**
   * Open a live-updating message for streamed agent output. Only one stream
   * per chat — a previous one is retired first. Returns undefined when the
   * placeholder message itself can't be sent (caller falls back to sendText).
   */
  async beginStream(externalChatId: string, initialText = ""): Promise<OutboundStream | undefined> {
    try {
      const chatId = this.chatId(externalChatId);
      const previous = this.activeStreams.get(externalChatId);
      if (previous) await previous.abort().catch(() => {});
      const sent = await this.api<TgMessage>("sendMessage", {
        chat_id: chatId,
        text: initialText.trim() ? renderStreamHtml(initialText) : "…",
        parse_mode: "HTML",
      });
      const stream = new TelegramOutboundStream(this, externalChatId, chatId, sent.message_id, this.opts);
      this.activeStreams.set(externalChatId, stream);
      stream.onClose = () => {
        if (this.activeStreams.get(externalChatId) === stream) this.activeStreams.delete(externalChatId);
      };
      await stream.start(initialText);
      return stream;
    } catch (err) {
      console.warn(`[hertz] telegram stream open failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** @internal — used by TelegramOutboundStream for overflow chunks of a long reply. */
  async sendHtmlChunk(externalChatId: string, htmlChunk: string): Promise<void> {
    await this.api("sendMessage", { chat_id: this.chatId(externalChatId), text: htmlChunk, parse_mode: "HTML" });
  }

  /** @internal — used by TelegramOutboundStream. */
  async editStreamMessage(chatId: string, messageId: number, html: string): Promise<void> {
    try {
      await this.api("editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML" });
    } catch (err) {
      const msg = (err as Error).message;
      // Throttled edits can race the final state — identical content is fine.
      if (/message is not modified/i.test(msg)) return;
      if (/can't parse entities|parse entities/i.test(msg)) {
        await this.api("editMessageText", { chat_id: chatId, message_id: messageId, text: stripTelegramHtml(html) });
        return;
      }
      throw err;
    }
  }

  /** @internal — used by TelegramOutboundStream. */
  async deleteStreamMessage(chatId: string, messageId: number): Promise<void> {
    await this.api("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
  }
}
