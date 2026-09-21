/** Czech relative time: "před 5 min", "před 2 h", "včera", "21. 9." */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "nikdy";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "za chvíli";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "právě teď";
  if (min < 60) return `před ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `před ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "včera";
  if (d < 7) return `před ${d} dny`;
  return new Date(t).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(iso);
  }
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "2-digit" });
  } catch {
    return String(iso);
  }
}

/** Compact message timestamp: "14:32" today, "včera 14:32", else "21. 9. 14:32". */
export function fmtMsgTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate();
  if (isYesterday) return `včera ${time}`;
  return `${d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" })} ${time}`;
}

export function truncate(s: string, max = 60): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** First text block of a message, for previews. */
export function firstText(content: Array<{ type: string; text?: string }>): string {
  for (const b of content) {
    if (b.type === "text" && b.text) return b.text;
  }
  return "";
}
