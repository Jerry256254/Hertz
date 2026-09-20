/**
 * Markdown → Telegram HTML converter.
 *
 * The Bot API "HTML" parse_mode understands only a tiny tag set
 * (b/i/u/s/a/code/pre/blockquote/...). Agent replies are Markdown, so sending
 * them raw shows literal `**` and backticks, and sending them with a parse
 * mode but unescaped breaks the request. This module converts the common
 * Markdown subset to Telegram-safe HTML and chunks long messages without
 * tearing entities apart.
 */

const PLACEHOLDER = "\u0000TGCODE";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function isSafeUrl(url: string): boolean {
  return /^https?:\/\/[^\s<>"']+$/i.test(url);
}

function formatInline(escaped: string): string {
  let out = escaped;
  // Links first (brackets may contain formatting chars, formatting may contain brackets — links win).
  out = out.replace(/\[([^\[\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const raw = url.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (!isSafeUrl(raw)) return text;
    return `<a href="${escapeAttr(raw)}">${text}</a>`;
  });
  // Bold + italic. Underscore variants only when not inside a word (snake_case stays intact).
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/(^|[\s>_\-(\[{])__([^_\n]+)__([\s<.,;:!?)\]}]|$)/g, "$1<b>$2</b>$3");
  out = out.replace(/(^|[\s>_\-(\[{*])\*([^*\n]+)\*([\s<.,;:!?)\]}]|$)/g, "$1<i>$2</i>$3");
  out = out.replace(/(^|[\s>_*\-(\[{])_([^_\n]+)_([\s<.,;:!?)\]}]|$)/g, "$1<i>$2</i>$3");
  // Strikethrough.
  out = out.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  return out;
}

/** Convert agent Markdown to HTML accepted by Telegram's parse_mode=HTML. */
export function markdownToTelegramHtml(src: string): string {
  const codeBlocks: string[] = [];
  const stash = (html: string): string => {
    codeBlocks.push(html);
    return `${PLACEHOLDER}${codeBlocks.length - 1}\u0000`;
  };

  // Fenced code blocks → <pre> (language hint dropped — Telegram has none).
  let text = src.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_m, code: string) =>
    `\n${stash(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`)}\n`,
  );
  // Inline code → <code>.
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(`<code>${escapeHtml(code)}</code>`));

  const lines = text.split("\n");
  const htmlLines: string[] = [];

  for (const line of lines) {
    // Code placeholders (\0TGCODE<n>\0) survive escaping + inline formatting
    // untouched, so they flow through the normal pipeline and are restored
    // at the end — even mid-line next to real text.
    const trimmed = line.trim();
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      continue; // horizontal rule has no Telegram equivalent
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      htmlLines.push(`<b>${formatInline(escapeHtml(heading[2]!.trim()))}</b>`);
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      htmlLines.push(`<blockquote>${formatInline(escapeHtml(trimmed.replace(/^>\s?/, "")))}</blockquote>`);
      continue;
    }
    const bullet = /^([-*+])\s+(.*)$/.exec(trimmed);
    if (bullet) {
      htmlLines.push(`• ${formatInline(escapeHtml(bullet[2]!))}`);
      continue;
    }
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      htmlLines.push(`${ordered[1]}. ${formatInline(escapeHtml(ordered[2]!))}`);
      continue;
    }
    if (trimmed === "") {
      htmlLines.push("");
      continue;
    }
    // Images → alt text (+ url when useful); bare image lines collapse to text.
    const imgAsText = trimmed.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) =>
      alt ? (isSafeUrl(url) ? `${alt} (${url})` : alt) : url,
    );
    htmlLines.push(formatInline(escapeHtml(imgAsText)));
  }

  let html = htmlLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  html = html.replace(new RegExp(`${PLACEHOLDER}(\\d+)\u0000`, "g"), (_m, i: string) => codeBlocks[Number(i)] ?? "");
  return html;
}

/** Strip all tags back to readable plain text (last-resort fallback). */
export function stripTelegramHtml(html: string): string {
  return html
    .replace(/<a\s+href="([^"]*)">([\s\S]*?)<\/a>/g, "$2 ($1)")
    .replace(/<\/?(?:b|i|u|s|code|pre|blockquote|strong|em|ins|strike|del|span|tg-spoiler)[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * Split converted HTML into chunks of at most `limit` chars. Prefers
 * paragraph boundaries; hard-splits long paragraphs but never tears an
 * HTML entity apart.
 */
export function chunkTelegramHtml(html: string, limit: number): string[] {
  if (html.length <= limit) return [html];
  const chunks: string[] = [];
  const paras = html.split("\n\n");
  let current = "";
  const push = (text: string) => {
    let rest = text;
    while (rest.length > limit) {
      let cut = limit;
      // Don't cut inside an entity: backtrack past a dangling "&...".
      const amp = rest.lastIndexOf("&", cut);
      if (amp !== -1 && amp > cut - 10) {
        const semi = rest.indexOf(";", amp);
        if (semi === -1 || semi > cut) cut = amp;
      }
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) chunks.push(rest);
  };
  for (const para of paras) {
    if (!para) continue;
    if (para.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      push(para);
      continue;
    }
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = para;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [html];
}
