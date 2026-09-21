/**
 * Emoji sanitizer for the agent's outbound chat text.
 *
 * The persona hard-bans emoji, but models occasionally slip one in anyway
 * ("Ahoj! 👋 Jsem tady."). This is the safety net: every assistant message is
 * stripped of emoji right before it is delivered to the web UI or a chat
 * channel (Telegram, Discord).
 *
 * Design goal: remove ONLY emoji. Legitimate text must survive untouched:
 * ©, ®, ™, arrows (→), stars (★), math symbols, currency signs, bullets —
 * none of these are removed unless they are explicitly presented AS emoji
 * (i.e. followed by U+FE0F, e.g. "❤️").
 *
 * What is removed:
 *  - characters that render as emoji by default (\p{Emoji_Presentation}:
 *    👋 😀 ✅ ❌ ⭐, flags 🇨🇿, …), including ZWJ-joined sequences (👨‍👩‍👧)
 *    and skin-tone modifiers (👋🏽);
 *  - keycap sequences ("1️⃣", "#️⃣");
 *  - tag sequences used for subdivision flags;
 *  - any Extended_Pictographic character followed by U+FE0F, i.e. a
 *    text-default glyph explicitly switched to emoji presentation
 *    ("❤️", "☀️", "✈️", "⚠️");
 *  - stray U+FE0F variation selectors (invisible on their own).
 *
 * Whitespace left behind by a removal is collapsed (runs of spaces/tabs become
 * one) and the ends are trimmed — but only when something was actually
 * removed, so untouched text is returned byte-identical. Newlines are never
 * collapsed, so code blocks and lists keep their shape.
 */

const MOD = "[\\u{1F3FB}-\\u{1F3FF}]"; // skin-tone modifiers
const EP_PRESENTED = "\\p{Emoji_Presentation}" + MOD + "?\\uFE0F?"; // e.g. 👋, ✅, ⭐, 👋🏽

const EMOJI_CLUSTER =
  // Emoji-presentation characters incl. ZWJ-joined sequences (👨‍👩‍👧‍👦)
  "(?:" + EP_PRESENTED + "(?:\\u200D\\p{Extended_Pictographic}" + MOD + "?\\uFE0F?)*)" +
  // Keycap sequences: "1️⃣", "*️⃣", "#️⃣"
  "|[0-9#*]\\uFE0F?\\u20E3" +
  // Tag sequences (subdivision flags like England/Scotland/Wales)
  "|[\\u{E0020}-\\u{E007E}]\\u{E007F}" +
  // Text-presentation glyphs explicitly marked as emoji ("❤️", "☀️")
  "|\\p{Extended_Pictographic}\\uFE0F" +
  // Stray emoji presentation selectors
  "|\\uFE0F";

const EMOJI_RE = new RegExp(EMOJI_CLUSTER, "gu");
const DOUBLE_SPACE_RE = /[ \t]{2,}/g;

/** Remove emoji from text. Returns the input unchanged when it has no emoji. */
export function stripEmoji(text: string): string {
  if (!text) return text;
  EMOJI_RE.lastIndex = 0;
  const without = text.replace(EMOJI_RE, "");
  if (without === text) return text;
  return without
    .replace(DOUBLE_SPACE_RE, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** True when the text contains at least one removable emoji cluster. */
export function hasEmoji(text: string): boolean {
  if (!text) return false;
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(text);
}
