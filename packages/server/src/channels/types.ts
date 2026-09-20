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
  onDecision(externalChatId: string, approvalId: string, decision: "approved" | "rejected"): Promise<void>;
}

export interface ChannelDriver {
  start(cb: ChannelCallbacks): Promise<void>;
  stop(): void;
  /** Throws when the token is invalid; resolves with the bot's public label otherwise. */
  verify(): Promise<string>;
  sendText(externalChatId: string, text: string): Promise<void>;
  /** Approval request with one-tap decision buttons where the platform supports them. */
  sendApproval(externalChatId: string, approvalId: string, summary: string, detail: string | null): Promise<void>;
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
