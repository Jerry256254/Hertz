import type { ContentBlock } from "./types";

/**
 * Prefix interní výzvy completion guardu (server ji ukládá jako zprávu s rolí
 * "user", starší záznamy navíc nemají žádný příznak skrytí). Shoduje se s
 * ARTIFACT_NUDGE_TEXT v packages/core/src/agent/agent-loop.ts.
 */
export const GUARD_NUDGE_PREFIX = "[Systémová kontrola dokončení";

/** Minimální tvar zprávy, který filtr potřebuje — sedí i na PersistedMessage. */
export interface VisibilityMessage {
  role: string;
  content: ContentBlock[];
  hidden?: boolean;
  visible?: boolean;
}

/** Spojený prostý text všech textových bloků zprávy. */
export function messageText(m: Pick<VisibilityMessage, "content">): string {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Interní zpráva, která se NIKDY nesmí ukázat v uživatelském chatu jako běžná
 * zpráva (ani jako uživatelská bublina). Pokrývá:
 * - příznak `hidden: true` / `visible: false`, které nastavuje server,
 * - roli `system`,
 * - textový fallback na prefix completion guardu pro staré záznamy bez příznaku.
 */
export function isInternalMessage(m: VisibilityMessage): boolean {
  if (m.hidden === true) return true;
  if (m.visible === false) return true;
  if (m.role === "system") return true;
  return messageText(m).trimStart().startsWith(GUARD_NUDGE_PREFIX);
}

/** Ze seznamu zpráv vynechá interní zprávy — ty se v chatu nikdy nerenderují. */
export function withoutInternalMessages<T extends VisibilityMessage>(messages: T[]): T[] {
  return messages.filter((m) => !isInternalMessage(m));
}
