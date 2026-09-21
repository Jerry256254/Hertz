/** Shared shapes for external chat channels (Telegram, Discord). */

export type ChannelKind = "telegram" | "discord";

export interface InboundMessage {
  /** "telegram:<chatId>" / "discord:<channelId>" — matches channel_bindings.external_chat_id. */
  externalChatId: string;
  senderLabel: string;
  /** Platform sender id (telegram user id / discord author id) for the sender allowlist. */
  senderId: string;
  text: string;
}

export interface ChannelCallbacks {
  onMessage(msg: InboundMessage): Promise<void>;
  /**
   * "approved" = allow once, "approved-session" = allow once + pre-approve the
   * same action for the rest of the session, "rejected" = deny.
   */
  onDecision(externalChatId: string, approvalId: string, decision: ChannelDecision): Promise<void>;
  /**
   * Platform UI callbacks that are not approvals: inline-picker selections from
   * bot commands (model pickers, chat switchers, confirmations…). Only fired by
   * drivers whose platform supports callback buttons (Telegram). messageId is
   * the id of the message carrying the buttons, so the handler can edit it in
   * place instead of posting a new message.
   */
  onCommandCallback?(
    externalChatId: string,
    action: string,
    payload: string,
    senderLabel: string,
    messageId?: number,
  ): Promise<void>;
}

/** A pending approval rendered for a chat channel: action preview + why it's gated. */
export interface ApprovalCard {
  /** One-line action summary ("Send offer e-mail to Novák"). */
  summary: string;
  /** Longer context: what exactly would be done. Null when none. */
  detail: string | null;
  /** Plain-language (Czech) explanation of why this action needs approval. */
  reason: string;
}

/** Verdicts a chat channel can deliver for an approval. */
export type ChannelDecision = "approved" | "rejected" | "approved-session";

export interface ChannelStartOptions {
  /**
   * Drop updates queued while the bot was offline. True on cold boot (answering
   * week-old messages is never right), false on an operator-initiated restart
   * where the backlog was written minutes ago and is still relevant.
   */
  dropBacklog?: boolean;
}

/**
 * A live-updated outbound message: the driver renders the agent's in-progress
 * reply with throttled edits and re-arms the typing indicator while open.
 * Drivers whose platform cannot edit messages return undefined from
 * beginStream() and the caller falls back to plain sendText().
 */
export interface OutboundStream {
  /** Render the current draft of the reply (throttled by the driver). */
  update(text: string): Promise<void>;
  /**
   * Render the final reply in place. When `finalText` is empty the placeholder
   * is removed instead, so a tool-only run leaves no litter behind.
   */
  finish(finalText: string): Promise<void>;
  /** Give up: stop typing, drop the placeholder, send nothing. */
  abort(): Promise<void>;
}

export interface ChannelDriver {
  start(cb: ChannelCallbacks, opts?: ChannelStartOptions): Promise<void>;
  stop(): void;
  /** Throws when the token is invalid; resolves with the bot's public label otherwise. */
  verify(): Promise<string>;
  /** Restart the inbound stream without touching configuration. */
  restart?(opts?: ChannelStartOptions): Promise<void>;
  sendText(externalChatId: string, text: string): Promise<void>;
  /**
   * Deliver a file as a document. The path was already resolved by the
   * send_file tool through the sandbox PathGuard (workspace roots only) —
   * drivers must treat it as trusted and never accept raw user paths here.
   */
  sendDocument?(
    externalChatId: string,
    file: { absolutePath: string; filename: string; caption?: string },
  ): Promise<void>;
  /** Approval request with one-tap decision buttons where the platform supports them. */
  sendApproval(externalChatId: string, approvalId: string, card: ApprovalCard): Promise<void>;
  /** Best-effort "is typing…" indicator; no-op where the platform lacks one. */
  typing?(externalChatId: string): Promise<void>;
  /** Open a live-updating message; undefined = platform cannot edit messages. */
  beginStream?(externalChatId: string, initialText?: string): Promise<OutboundStream | undefined>;
}

/** Split long texts on paragraph boundaries so no chunk exceeds the platform limit. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Parse the decision commands shared by all channels: /approve <id>, !reject <id>, … */
export function parseDecisionCommand(text: string): { approvalId: string; decision: "approved" | "rejected" } | undefined {
  const match = /^\s*[!/](approve|deny|reject)\s+([A-Za-z0-9_-]+)\s*$/i.exec(text);
  if (!match) return undefined;
  return {
    approvalId: match[2]!,
    decision: match[1]!.toLowerCase() === "approve" ? "approved" : "rejected",
  };
}

export function isNewChatCommand(text: string): boolean {
  return /^\s*[!/](new|reset|newchat)\s*$/.test(text);
}

/** /clear wipes the current chat's messages (memory, skills and notes survive). */
export function isClearCommand(text: string): boolean {
  return /^\s*[!/]clear\s*$/.test(text);
}

export interface ParsedChannelCommand {
  /** Canonical command name (Czech), e.g. "pomoc". */
  name: string;
  /** Raw argument text after the command word (may be empty). */
  args: string;
}

/**
 * Canonical Czech command names with the aliases users may type.
 * Kept here (not in the Telegram module) so every channel shares one grammar.
 */
const COMMAND_ALIASES: Record<string, string> = {
  start: "pomoc",
  help: "pomoc",
  pomoc: "pomoc",
  stav: "stav",
  status: "stav",
  restart: "restart",
  odpojit: "odpojit",
  disconnect: "odpojit",
  novy: "novy",
  new: "novy",
  newchat: "novy",
  reset: "novy",
  vycistit: "vycistit",
  clear: "vycistit",
  jmeno: "jmeno",
  name: "jmeno",
  model: "model",
  rezim: "rezim",
  mode: "rezim",
  chaty: "chaty",
  chats: "chaty",
  pamet: "pamet",
  memory: "pamet",
  zapamatuj: "zapamatuj",
  remember: "zapamatuj",
  zapomen: "zapomen",
  forget: "zapomen",
  hledej: "hledej",
  search: "hledej",
  skilly: "skilly",
  skills: "skilly",
  pauza: "pauza",
  pause: "pauza",
  zastavit: "zastavit",
  stop: "zastavit",
  pokracuj: "pokracuj",
  resume: "pokracuj",
  continue: "pokracuj",
  schvaleni: "schvaleni",
  approvals: "schvaleni",
  schvalit: "schvalit",
  approve: "schvalit",
  zamitnout: "zamitnout",
  reject: "zamitnout",
  deny: "zamitnout",
  obrazovka: "obrazovka",
  screen: "obrazovka",
  pocitac: "obrazovka",
};

/** Parse "/prikaz args" / "!prikaz args" into a canonical command, or undefined. */
export function parseChannelCommand(text: string): ParsedChannelCommand | undefined {
  const match = /^\s*[!/]([a-zA-Zá-žÁ-Ž]+)(?:\s+(.*?))?\s*$/.exec(text);
  if (!match) return undefined;
  const canonical = COMMAND_ALIASES[match[1]!.toLowerCase()];
  if (!canonical) return undefined;
  return { name: canonical, args: (match[2] ?? "").trim() };
}

/** True for any text that addresses the bot as a command (not a chat message). */
export function isChannelCommand(text: string): boolean {
  return parseChannelCommand(text) !== undefined;
}
