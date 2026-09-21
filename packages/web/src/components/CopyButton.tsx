import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Zkopíruje text do schránky.
 * Primárně async clipboard API, fallback pro starší prohlížeče
 * (a nezabezpečené kontexty) přes dočasný textarea + execCommand.
 */
async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Např. nezabezpečený kontext — propadneme na fallback níže.
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

/**
 * Tlačítko „Kopírovat“ — zkopíruje předaný text do schránky a na ~2 s
 * potvrdí stav „Zkopírováno“ (fajfka, žádné emoji). Styl je konzistentní
 * s design systémem aplikace, tap target má min. 44 px (funguje i na mobilu),
 * přístupnost přes aria-label a aria-live.
 */
export function CopyButton({
  value,
  ariaLabel,
  className = "",
}: {
  /** Text, který se zkopíruje do schránky. */
  value: string;
  /** Přístupný popisek; výchozí „Zkopírovat do schránky“. */
  ariaLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  async function handleClick() {
    try {
      await copyToClipboard(value);
    } catch {
      // Tiché selhání kopírování — tlačítko zůstane v původním stavu.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={copied}
      aria-label={ariaLabel ?? "Zkopírovat do schránky"}
      className={`pressable inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border border-border bg-bg-sunken px-4 py-2 text-[12.5px] font-[600] text-fg outline-none transition-colors hover:border-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 ${copied ? "border-accent text-accent" : ""} ${className}`}
    >
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      <span aria-live="polite">{copied ? "Zkopírováno" : "Kopírovat"}</span>
    </button>
  );
}
