import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Check, Clock, Fingerprint, Heart, ListTodo, Plus, ShieldCheck, X } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, AgentLayeredMemory, Routine, SessionListItem } from "../lib/types";
import { fmtDate, relTime } from "../lib/format";
import { AgentAvatar } from "../components/AgentAvatar";
import { ApprovalCard, ApprovalHistoryRow, useApprovals } from "./Approvals";

export type AgentTab = "activity" | "approvals" | "routines" | "identity";

export function AgentPanel({
  agent,
  projectId,
  tab,
  onTabChange,
  onOpenSoul,
  onOpenMemory,
  onRename,
}: {
  agent: Agent;
  projectId: string;
  tab: AgentTab;
  onTabChange: (t: AgentTab) => void;
  onOpenSoul: () => void;
  onOpenMemory: () => void;
  onRename: (name: string) => void;
}) {
  const { data: approvalsData } = useApprovals();
  const pendingCount = (approvalsData?.approvals ?? []).filter((a) => a.status === "pending").length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* profile header */}
      <div className="flex shrink-0 flex-col items-center px-4 pb-3 pt-5">
        <AgentAvatar seed={agent.id} size={72} />
        <p className="mt-2 text-[17px] font-[700] tracking-[-0.02em] text-fg">{agent.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-fg-muted">
          <span className="h-2 w-2 rounded-full bg-live" /> Připojeno
        </p>
        <div className="mt-3 grid w-full grid-cols-4 gap-1 rounded-full border border-border bg-bg-raised p-1">
          <PanelTabButton active={tab === "activity"} onClick={() => onTabChange("activity")} title="Aktivita">
            <ListTodo size={16} />
          </PanelTabButton>
          <PanelTabButton active={tab === "approvals"} onClick={() => onTabChange("approvals")} title="Schválení" badge={pendingCount}>
            <ShieldCheck size={16} />
          </PanelTabButton>
          <PanelTabButton active={tab === "routines"} onClick={() => onTabChange("routines")} title="Rutiny">
            <Clock size={16} />
          </PanelTabButton>
          <PanelTabButton active={tab === "identity"} onClick={() => onTabChange("identity")} title="Identita">
            <Fingerprint size={16} />
          </PanelTabButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {tab === "activity" && <ActivityTab agentId={agent.id} />}
        {tab === "approvals" && <ApprovalsTab />}
        {tab === "routines" && <RoutinesTab agent={agent} projectId={projectId} />}
        {tab === "identity" && <IdentityTab agent={agent} onOpenSoul={onOpenSoul} onOpenMemory={onOpenMemory} onRename={onRename} />}
      </div>
    </div>
  );
}

function PanelTabButton({ active, onClick, title, children, badge }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode; badge?: number }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`pressable relative flex items-center justify-center rounded-full py-2 ${active ? "bg-bg-sunken text-fg" : "text-fg-subtle hover:text-fg-muted"}`}
    >
      {children}
      {!!badge && badge > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-[700] text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

function ActivityTab({ agentId }: { agentId: string }) {
  const { data } = useQuery({
    queryKey: ["sessions", "all"],
    queryFn: () => api.get<{ sessions: SessionListItem[] }>("/sessions"),
    refetchInterval: 10000,
  });
  const sessions = (data?.sessions ?? []).filter((s) => s.agentId === agentId).slice(0, 30);
  const today = sessions.filter((s) => Date.now() - new Date(s.updatedAt).getTime() < 24 * 3600 * 1000);
  const older = sessions.filter((s) => Date.now() - new Date(s.updatedAt).getTime() >= 24 * 3600 * 1000);

  return (
    <div>
      <p className="px-2 pb-1 pt-1 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">DNEŠEK</p>
      {today.length === 0 && <p className="px-2 py-3 text-[13px] text-fg-subtle">Zatím žádná aktivita. Napiš agentovi v hlavním chatu.</p>}
      {today.map((s) => (
        <ActivityRow key={s.id} title={s.title} desc={s.projectName} time={relTime(s.updatedAt)} />
      ))}
      {older.length > 0 && (
        <>
          <p className="px-2 pb-1 pt-3 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">DŘÍVE</p>
          {older.map((s) => (
            <ActivityRow key={s.id} title={s.title} desc={s.projectName} time={relTime(s.updatedAt)} />
          ))}
        </>
      )}
    </div>
  );
}

function ActivityRow({ title, desc, time }: { title: string; desc: string; time: string }) {
  return (
    <div className="flex items-start gap-3 rounded-[14px] px-2 py-2.5 hover:bg-bg-sunken/50">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-fg-muted"><Activity size={15} /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-[600] text-fg">{title}</p>
        <p className="truncate text-[12px] text-fg-muted">{desc}</p>
      </div>
      <span className="shrink-0 text-[11.5px] text-fg-subtle">{time}</span>
    </div>
  );
}

function ApprovalsTab() {
  const { data, isLoading } = useApprovals();
  const approvals = data?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === "pending");
  const history = approvals.filter((a) => a.status !== "pending");

  if (isLoading) return <p className="px-2 py-4 text-[13px] text-fg-subtle">Načítám…</p>;
  return (
    <div className="space-y-3">
      {pending.length > 0 && (
        <div className="space-y-2.5">
          <p className="px-2 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">ČEKÁ NA ROZHODNUTÍ</p>
          {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
        </div>
      )}
      <div>
        <p className="px-2 pb-1 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">HISTORIE SCHVÁLENÍ</p>
        {history.length === 0 && <p className="px-2 py-2 text-[13px] text-fg-subtle">Zatím žádná historie.</p>}
        {history.map((a) => <ApprovalHistoryRow key={a.id} approval={a} />)}
      </div>
    </div>
  );
}

function RoutinesTab({ agent, projectId }: { agent: Agent; projectId: string }) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [schedule, setSchedule] = useState("daily 09:00");
  const { data } = useQuery({
    queryKey: ["routines", projectId],
    queryFn: () => api.get<{ routines: Routine[] }>(`/projects/${projectId}/routines`),
  });
  const routines = (data?.routines ?? []).filter((r) => r.agentId === agent.id);

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/routines/${id}`, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["routines", projectId] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/routines/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["routines", projectId] }),
  });
  const create = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/routines`, { agentId: agent.id, title, taskTemplate: task, schedule }),
    onSuccess: () => {
      setShowForm(false);
      setTitle("");
      setTask("");
      setSchedule("daily 09:00");
      void queryClient.invalidateQueries({ queryKey: ["routines", projectId] });
    },
  });

  const heartbeatOn = agent.heartbeatMinutes > 0;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-2">
        <p className="text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">DENNĚ</p>
        <button onClick={() => setShowForm((v) => !v)} className="pressable flex h-7 w-7 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-muted hover:text-fg">
          {showForm ? <X size={14} /> : <Plus size={14} />}
        </button>
      </div>

      {showForm && (
        <div className="mb-2 space-y-2 rounded-[16px] border border-border bg-bg-raised p-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Název rutiny" className="h-10 w-full rounded-full border border-border bg-bg-sunken px-4 text-[13px] text-fg outline-none focus:border-accent" />
          <textarea value={task} onChange={(e) => setTask(e.target.value)} placeholder="Co má agent udělat…" rows={2} className="w-full resize-none rounded-[14px] border border-border bg-bg-sunken px-4 py-2.5 text-[13px] text-fg outline-none focus:border-accent" />
          <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="Rozvrh — např. daily 09:00" className="h-10 w-full rounded-full border border-border bg-bg-sunken px-4 text-[13px] text-fg outline-none focus:border-accent" />
          <button onClick={() => create.mutate()} disabled={!title.trim() || !task.trim() || create.isPending} className="pressable w-full rounded-full bg-accent py-2 text-[13px] font-[600] text-white disabled:opacity-40">
            Přidat rutinu
          </button>
          {create.isError && <p className="text-[12px] text-danger">{(create.error as Error).message}</p>}
        </div>
      )}

      <RoutineRow
        title="Heartbeat"
        desc={heartbeatOn ? `Každých ${agent.heartbeatMinutes} minut` : "Vypnuto — zapneš v Nastavení → Obecné"}
        enabled={heartbeatOn}
        locked
      />
      {routines.map((r) => (
        <div key={r.id} className="group flex items-center gap-3 rounded-[14px] px-2 py-2.5 hover:bg-bg-sunken/50">
          <button
            onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
            className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 ${r.enabled ? "justify-end bg-live" : "justify-start bg-bg-sunken"}`}
            title={r.enabled ? "Vypnout" : "Zapnout"}
          >
            <span className="h-5 w-5 rounded-full bg-white shadow" />
          </button>
          <div className="min-w-0 flex-1">
            <p className={`truncate text-[13px] font-[600] ${r.enabled ? "text-fg" : "text-fg-subtle"}`}>{r.title}</p>
            <p className="truncate text-[12px] text-fg-muted">{r.nextRunAt ? relTime(r.nextRunAt) : r.schedule}</p>
          </div>
          <button onClick={() => remove.mutate(r.id)} title="Smazat" className="hidden rounded-full p-1.5 text-fg-subtle hover:text-danger group-hover:block">
            <X size={14} />
          </button>
        </div>
      ))}
      {routines.length === 0 && <p className="px-2 py-2 text-[13px] text-fg-subtle">Žádné vlastní rutiny. Přidej první tlačítkem +.</p>}
    </div>
  );
}

function RoutineRow({ title, desc, enabled, locked = false }: { title: string; desc: string; enabled: boolean; locked?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-[14px] px-2 py-2.5">
      <span className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 ${enabled ? "justify-end bg-live" : "justify-start bg-bg-sunken"} ${locked ? "opacity-60" : ""}`}>
        <span className="h-5 w-5 rounded-full bg-white shadow" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-[600] text-fg">{title}</p>
        <p className="truncate text-[12px] text-fg-muted">{desc}</p>
      </div>
    </div>
  );
}

function IdentityTab({ agent, onOpenSoul, onOpenMemory, onRename }: { agent: Agent; onOpenSoul: () => void; onOpenMemory: () => void; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const { data: memory } = useQuery({
    queryKey: ["memory", agent.id],
    queryFn: () => api.get<AgentLayeredMemory>(`/agents/${agent.id}/memory`),
  });

  function commit() {
    setEditing(false);
    const t = name.trim();
    if (t && t !== agent.name) onRename(t);
    else setName(agent.name);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-[16px] border border-border bg-bg-raised px-4 py-3">
        {editing ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setName(agent.name); setEditing(false); } }} className="h-9 w-full rounded-full border border-accent bg-bg-sunken px-3.5 text-[14px] text-fg outline-none" />
        ) : (
          <>
            <p className="text-[15px] font-[600] text-fg">{agent.name}</p>
            <button onClick={() => setEditing(true)} className="pressable rounded-full border border-border bg-bg-sunken px-4 py-1.5 text-[12.5px] font-[600] text-fg hover:bg-bg-hover">
              Upravit
            </button>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <button onClick={onOpenSoul} className="pressable relative overflow-hidden rounded-[20px] p-4 text-left" style={{ background: "linear-gradient(150deg, var(--color-soul-from), var(--color-soul-to))" }}>
          <Heart size={18} className="text-white/90" />
          <p className="mt-6 text-[17px] font-[800] tracking-[-0.02em] text-white">SOUL</p>
          <p className="text-[10px] font-[700] tracking-[0.08em] text-white/70">PŘISTUPOVAT OPATRNĚ</p>
          <p className="mono mt-1 text-[11px] text-white/70">{fmtDate(agent.createdAt)}</p>
        </button>
        <button onClick={onOpenMemory} className="pressable relative overflow-hidden rounded-[20px] p-4 text-left" style={{ background: "linear-gradient(150deg, var(--color-memory-from), var(--color-memory-to))" }}>
          <Fingerprint size={18} className="text-white/90" />
          <p className="mt-6 text-[17px] font-[800] tracking-[-0.02em] text-white">PAMĚŤ</p>
          <p className="text-[10px] font-[700] tracking-[0.08em] text-white/70">VRSTVENÁ PAMĚŤ</p>
          <p className="mono mt-1 text-[11px] text-white/70">
            {(memory?.atoms.length ?? 0) + (memory?.notes.length ?? 0)} záznamů
          </p>
        </button>
      </div>

      <div className="rounded-[16px] border border-border bg-bg-raised px-4 py-3 text-[12.5px] leading-relaxed text-fg-muted">
        <p className="flex items-center gap-1.5"><Check size={13} className="text-live" /> Model: <span className="mono text-fg">{agent.model}</span></p>
        <p className="mt-1 flex items-center gap-1.5"><Check size={13} className="text-live" /> Počítač: {agent.isolated ? "izolovaný kontejner" : "místní běh"}</p>
      </div>
    </div>
  );
}
