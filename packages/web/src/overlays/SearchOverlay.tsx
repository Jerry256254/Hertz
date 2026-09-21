import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle, Search, X } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, SessionListItem } from "../lib/types";
import { relTime } from "../lib/format";

/** Centered search overlay — recent chats + filter. */
export function SearchOverlay({ agent, onClose, onSelect }: { agent: Agent; onClose: () => void; onSelect: (sessionId: string) => void }) {
  const [q, setQ] = useState("");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => api.get<{ sessions: SessionListItem[] }>("/sessions"),
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sessions = useMemo(() => {
    const mine = (data?.sessions ?? []).filter((s) => s.agentId === agent.id);
    const query = q.trim().toLowerCase();
    const filtered = query ? mine.filter((s) => s.title.toLowerCase().includes(query)) : mine;
    return [...filtered].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)).slice(0, 12);
  }, [data, q, agent.id]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 px-4 pt-[12vh]" style={{ backdropFilter: "blur(6px)" }} onClick={onClose}>
      <div className="w-full max-w-[560px] overflow-hidden rounded-[24px] border border-border bg-bg-raised shadow-popover animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          <Search size={17} className="shrink-0 text-fg-subtle" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hledat" className="w-full bg-transparent text-[16px] text-fg placeholder:text-fg-subtle outline-none" />
          <button onClick={onClose} className="rounded-full p-1.5 text-fg-subtle hover:bg-bg-sunken hover:text-fg"><X size={16} /></button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2.5">
          <p className="px-3 pb-1 pt-1.5 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">{q.trim() ? "VÝSLEDKY" : "NEDÁVNÉ"}</p>
          {isLoading && <p className="px-3 py-4 text-[13px] text-fg-subtle">Hledám…</p>}
          {isError && <p className="px-3 py-4 text-[13px] text-danger">Hledání se nezdařilo.</p>}
          {!isLoading && !isError && sessions.length === 0 && <p className="px-3 py-4 text-[13px] text-fg-subtle">Nic jsem nenašel.</p>}
          {sessions.map((s) => (
            <button key={s.id} onClick={() => { onSelect(s.id); onClose(); }} className="flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left hover:bg-bg-sunken">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-fg-muted"><MessageCircle size={15} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-[600] text-fg">{s.title}</span>
                <span className="block truncate text-[12px] text-fg-muted">{s.projectName} · {relTime(s.updatedAt)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
