import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Layers, StickyNote, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, AgentLayeredMemory } from "../lib/types";
import { relTime } from "../lib/format";
import { Markdown } from "../components/Markdown";

/** Memory view: persona (L3) / scenarios (L2) / atoms (L1). */
export function MemoryView({ agent, onOpenSoul, bare = false }: { agent: Agent; onOpenSoul: () => void; bare?: boolean }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"persona" | "scenarios" | "atoms">("persona");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["memory", agent.id],
    queryFn: () => api.get<AgentLayeredMemory>(`/agents/${agent.id}/memory`),
  });
  const forget = useMutation({
    mutationFn: (noteId: string) => api.delete(`/agents/${agent.id}/memory/${noteId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["memory", agent.id] }),
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!bare && (
        <header className="flex h-[60px] shrink-0 items-center gap-3 px-3 md:px-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-info-wash text-info"><Brain size={18} /></span>
          <div>
            <p className="text-[16px] font-[700] tracking-[-0.02em] text-fg">Paměť</p>
            <p className="text-[12px] text-fg-muted">Co si {agent.name} pamatuje</p>
          </div>
          <span className="flex-1" />
          <button onClick={onOpenSoul} className="pressable rounded-full border border-border bg-bg-raised px-4 py-2 text-[13px] font-[600] text-fg hover:bg-bg-hover">
            Otevřít SOUL.md
          </button>
        </header>
      )}

      <div className={`shrink-0 ${bare ? "" : "px-3 md:px-5"}`}>
        <div className="mx-auto grid w-full max-w-[760px] grid-cols-3 gap-1 rounded-full border border-border bg-bg-raised p-1">
          <MemoryTab active={tab === "persona"} onClick={() => setTab("persona")}>Osobnost</MemoryTab>
          <MemoryTab active={tab === "scenarios"} onClick={() => setTab("scenarios")}>Scénáře ({data?.scenarios.length ?? 0})</MemoryTab>
          <MemoryTab active={tab === "atoms"} onClick={() => setTab("atoms")}>Atomy ({data?.atoms.length ?? 0})</MemoryTab>
        </div>
      </div>

      <div className={`min-h-0 flex-1 ${bare ? "" : "overflow-y-auto px-3 py-4 md:px-5"}`}>
        <div className={`mx-auto w-full max-w-[760px] ${bare ? "pt-3" : ""}`}>
          {isLoading && <p className="py-8 text-center text-[13px] text-fg-subtle">Načítám paměť…</p>}
          {isError && !data && (
            <div className="rounded-[20px] border border-danger/30 bg-danger-wash p-5 text-center">
              <p className="text-[13.5px] font-[600] text-fg">Paměť se nepodařilo načíst.</p>
              <button onClick={() => refetch()} className="pressable mt-3 rounded-full bg-danger px-4 py-2 text-[13px] font-[600] text-white">
                Zkusit znovu
              </button>
            </div>
          )}
          {data && tab === "persona" && (
            <div className="rounded-[20px] border border-border bg-bg-raised p-5">
              {data.persona ? <Markdown>{data.persona}</Markdown> : <p className="text-[13.5px] text-fg-subtle">Agent si zatím nevytvořil osobnost. Vznikne sama z konverzací.</p>}
            </div>
          )}
          {data && tab === "scenarios" && (
            <div className="space-y-2.5">
              {data.scenarios.length === 0 && <p className="py-4 text-center text-[13px] text-fg-subtle">Zatím žádné scénáře.</p>}
              {data.scenarios.map((s) => (
                <div key={s.id} className="rounded-[20px] border border-border bg-bg-raised p-4">
                  <div className="flex items-center gap-2">
                    <Layers size={14} className="shrink-0 text-info" />
                    <p className="flex-1 truncate text-[14px] font-[600] text-fg">{s.title}</p>
                    <span className="mono shrink-0 text-[11px] text-fg-subtle">{s.slug}</span>
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">{s.summary}</p>
                  <p className="mt-1.5 text-[11.5px] text-fg-subtle">aktualizováno {relTime(s.updatedAt)}</p>
                </div>
              ))}
            </div>
          )}
          {data && tab === "atoms" && (
            <div className="space-y-2">
              {data.atoms.length === 0 && data.notes.length === 0 && <p className="py-4 text-center text-[13px] text-fg-subtle">Zatím žádné vzpomínky.</p>}
              {data.atoms.map((a) => (
                <div key={a.id} className="group flex items-start gap-2.5 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
                  <StickyNote size={14} className="mt-0.5 shrink-0 text-fg-subtle" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] leading-relaxed text-fg">{a.text}</p>
                    <p className="mt-1 text-[11.5px] text-fg-subtle">důležitost {a.importance} · {relTime(a.createdAt)}</p>
                  </div>
                  <button onClick={() => forget.mutate(a.id)} title="Zapomenout" className="shrink-0 rounded-full p-1.5 text-fg-subtle hover:text-danger [@media(hover:hover)]:invisible [@media(hover:hover)]:group-hover:visible">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {data.notes.filter((n) => !data.atoms.some((a) => a.id === n.id)).map((n) => (
                <div key={n.id} className="group flex items-start gap-2.5 rounded-[16px] border border-border bg-bg-raised px-4 py-3">
                  <StickyNote size={14} className="mt-0.5 shrink-0 text-fg-subtle" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] leading-relaxed text-fg">{n.note}</p>
                    <p className="mt-1 text-[11.5px] text-fg-subtle">{relTime(n.createdAt)}</p>
                  </div>
                  <button onClick={() => forget.mutate(n.id)} title="Zapomenout" className="shrink-0 rounded-full p-1.5 text-fg-subtle hover:text-danger [@media(hover:hover)]:invisible [@media(hover:hover)]:group-hover:visible">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MemoryTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`pressable rounded-full py-2 text-[13px] font-[600] ${active ? "bg-bg-sunken text-fg" : "text-fg-subtle hover:text-fg-muted"}`}>
      {children}
    </button>
  );
}
