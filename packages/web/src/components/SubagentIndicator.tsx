import { useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import type { SubagentInfo } from "../lib/types";

const STATUS_LABEL: Record<SubagentInfo["status"], string> = {
  pending: "čeká ve frontě",
  running: "pracuje",
  done: "hotovo",
  failed: "selhal",
  interrupted: "zastaven",
};

/**
 * Kompaktní indikátor podagentů v chatu: uživatel vidí, že na pozadí běží
 * podagenti a na čem. Výsledek se doručí jako součást odpovědi hlavního agenta.
 */
export function SubagentIndicator({ subagents }: { subagents: SubagentInfo[] }) {
  const [open, setOpen] = useState(false);
  const active = subagents.filter((s) => s.status === "pending" || s.status === "running");
  if (active.length === 0) return null;

  const names = active.map((s) => s.label).join(", ");
  return (
    <div className="shrink-0 px-3 pt-2 md:px-5">
      <div className="mx-auto w-full max-w-[760px]">
        <button
          onClick={() => setOpen((o) => !o)}
          className="pressable flex w-full items-center gap-2 rounded-[14px] border border-border bg-bg-raised px-3.5 py-2 text-left hover:bg-bg-hover"
          title="Podagenti pracující na pozadí"
        >
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-live opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-live" />
          </span>
          <Bot size={14} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-muted">
            Pracují podagenti: <span className="font-[600] text-fg">{names}</span>
          </span>
          <ChevronDown size={13} className={`shrink-0 text-fg-subtle transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <div className="mt-1.5 overflow-hidden rounded-[14px] border border-border bg-bg-raised">
            {active.map((s) => (
              <div key={s.id} className="flex items-start gap-2 border-b border-border/60 px-3.5 py-2 last:border-0">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${s.status === "running" ? "bg-live animate-pulse" : "bg-warning"}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-[600] text-fg">{s.label}</p>
                  <p className="truncate text-[11.5px] text-fg-muted">
                    {STATUS_LABEL[s.status]}
                    {s.progress ? ` — ${s.progress}` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
