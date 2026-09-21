import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Brain, Check, Clock, Cpu, Fingerprint, ListTodo, Monitor, Pencil, Plus, RefreshCw, ShieldCheck, User, X, Zap } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Agent, AgentLayeredMemory, ProviderConfig, Routine, SessionListItem } from "../lib/types";
import { fmtDate, relTime } from "../lib/format";
import { AgentAvatar, avatarVersionOf } from "../components/AgentAvatar";
import { ModelFields } from "../components/ModelFields";
import { ApprovalCard, ApprovalHistoryRow, useApprovals } from "./Approvals";
import { MemoryView } from "../views/MemoryView";
import { ComputerView } from "../views/ComputerView";
import { SkillsEditor } from "../views/SkillsEditor";

export type AgentTab = "activity" | "approvals" | "routines" | "identity" | "skills" | "memory" | "computer";

export function AgentPanel({
  agent,
  projectId,
  tab,
  onTabChange,
  onClose,
  onOpenSoul,
  onOpenUserProfile,
  onOpenMemory,
  onRename,
}: {
  agent: Agent;
  projectId: string;
  tab: AgentTab;
  onTabChange: (t: AgentTab) => void;
  onClose: () => void;
  onOpenSoul: () => void;
  onOpenUserProfile: () => void;
  onOpenMemory: () => void;
  onRename: (name: string) => void;
}) {
  const { data: approvalsData } = useApprovals();
  const pendingCount = (approvalsData?.approvals ?? []).filter((a) => a.status === "pending").length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* profile header */}
      <div className="relative flex shrink-0 flex-col items-center px-4 pb-2.5 pt-4">
        <button onClick={onClose} title="Zavřít panel" aria-label="Zavřít panel" className="pressable absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full text-fg-muted hover:bg-bg-sunken hover:text-fg">
          <X size={14} />
        </button>
        <AgentAvatar seed={agent.id} version={avatarVersionOf(agent)} size={48} />
        <p className="mt-1.5 text-[15px] font-[700] tracking-[-0.02em] text-fg">{agent.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-live" /> Připojeno
        </p>
        <ModelRow agent={agent} />
        <div className="mt-2.5 grid w-full grid-cols-7 gap-1 rounded-full border border-border bg-bg-raised p-0.5">
          <PanelTabButton active={tab === "activity"} onClick={() => onTabChange("activity")} title="Aktivita">
            <ListTodo size={14} />
          </PanelTabButton>
          <PanelTabButton active={tab === "approvals"} onClick={() => onTabChange("approvals")} title="Schválení" badge={pendingCount}>
            <ShieldCheck size={14} />
          </PanelTabButton>
          <PanelTabButton active={tab === "routines"} onClick={() => onTabChange("routines")} title="Rutiny">
            <Clock size={14} />
          </PanelTabButton>
          <PanelTabButton active={tab === "identity"} onClick={() => onTabChange("identity")} title="Identita">
            <Fingerprint size={14} />
          </PanelTabButton>
          <PanelTabButton active={tab === "skills"} onClick={() => onTabChange("skills")} title="Dovednosti">
            <Zap size={14} />
          </PanelTabButton>
          <PanelTabButton active={tab === "memory"} onClick={() => onTabChange("memory")} title="Paměť">
            <Brain size={14} />
          </PanelTabButton>
          <PanelTabButton active={tab === "computer"} onClick={() => onTabChange("computer")} title="Počítač">
            <Monitor size={14} />
          </PanelTabButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {tab === "activity" && <ActivityTab agentId={agent.id} />}
        {tab === "approvals" && <ApprovalsTab />}
        {tab === "routines" && <RoutinesTab agent={agent} projectId={projectId} />}
        {tab === "identity" && <IdentityTab agent={agent} onOpenSoul={onOpenSoul} onOpenUserProfile={onOpenUserProfile} onOpenMemory={onOpenMemory} onRename={onRename} />}
        {tab === "skills" && <SkillsEditor agent={agent} />}
        {tab === "memory" && <MemoryView agent={agent} onOpenSoul={onOpenSoul} bare />}
        {tab === "computer" && <ComputerView agent={agent} projectId={projectId} bare />}
      </div>
    </div>
  );
}

/** Current model + provider, with an inline editor (no trip to Settings needed). */
function ModelRow({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState(agent.providerConfigId);
  const [model, setModel] = useState(agent.model);
  const [err, setErr] = useState<string | null>(null);

  const { data: providersData } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
    enabled: open,
  });
  const providers = providersData?.providers ?? [];
  const currentProvider = providers.find((p) => p.id === agent.providerConfigId);

  const save = useMutation({
    mutationFn: () => api.patch(`/agents/${agent.id}`, { providerConfigId: providerId, model: model.trim() }),
    onSuccess: () => {
      setOpen(false);
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Uložení selhalo"),
  });

  function startEdit() {
    setProviderId(agent.providerConfigId);
    setModel(agent.model);
    setErr(null);
    setOpen(true);
  }

  if (!open) {
    return (
      <button onClick={startEdit} title="Změnit model" className="pressable mt-2.5 flex w-full items-center gap-2 rounded-[14px] border border-border bg-bg-raised px-3.5 py-2 text-left hover:bg-bg-hover">
        <Cpu size={14} className="shrink-0 text-fg-muted" />
        <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-fg">{agent.model}</span>
        <Pencil size={12} className="shrink-0 text-fg-subtle" />
      </button>
    );
  }

  return (
    <div className="mt-2.5 w-full rounded-[16px] border border-border bg-bg-raised p-3">
      <ModelFields providerId={providerId} onProviderIdChange={setProviderId} model={model} onModelChange={setModel} idPrefix="panel" />
      {currentProvider && <p className="mt-1.5 text-[11.5px] text-fg-subtle">Nyní: {currentProvider.label} · {agent.model}</p>}
      {err && <p className="mt-2 text-[12px] text-danger">{err}</p>}
      <div className="mt-2.5 flex gap-2">
        <button onClick={() => save.mutate()} disabled={save.isPending || !model.trim()} className="pressable flex-1 rounded-full bg-accent py-2 text-[13px] font-[600] text-white disabled:opacity-40">
          {save.isPending ? "Ukládám…" : "Uložit"}
        </button>
        <button onClick={() => setOpen(false)} className="pressable rounded-full border border-border bg-bg-sunken px-4 py-2 text-[13px] font-[600] text-fg">Zrušit</button>
      </div>
    </div>
  );
}

function PanelTabButton({ active, onClick, title, children, badge }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode; badge?: number }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`pressable relative flex items-center justify-center rounded-full py-1.5 ${active ? "bg-bg-sunken text-fg" : "text-fg-subtle hover:text-fg-muted"}`}
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
      <p className="px-2 pb-1 pt-1 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">Dnešek</p>
      {today.length === 0 && <p className="px-2 py-3 text-[13px] text-fg-subtle">Zatím žádná aktivita. Napiš agentovi v hlavním chatu.</p>}
      {today.map((s) => (
        <ActivityRow key={s.id} title={s.title} desc={s.projectName} time={relTime(s.updatedAt)} />
      ))}
      {older.length > 0 && (
        <>
          <p className="px-2 pb-1 pt-3 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">Dříve</p>
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
          <p className="px-2 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">Čeká na rozhodnutí</p>
          {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
        </div>
      )}
      <div>
        <p className="px-2 pb-1 text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">Historie schválení</p>
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
        <p className="text-[12px] font-[700] tracking-[0.05em] text-fg-subtle">Denně</p>
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
        desc={heartbeatOn ? `Každých ${agent.heartbeatMinutes} minut` : "Vypnuto — zapneš v Nastavení › Obecné"}
        enabled={heartbeatOn}
        locked
      />
      {routines.map((r) => (
        <div key={r.id} className="group flex items-center gap-3 rounded-[14px] px-2 py-2.5 hover:bg-bg-sunken/50">
          <button
            onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
            className={`relative flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 before:absolute before:-inset-3 before:content-[''] ${r.enabled ? "justify-end bg-live" : "justify-start bg-bg-sunken"}`}
            title={r.enabled ? "Vypnout" : "Zapnout"}
          >
            <span className="h-5 w-5 rounded-full bg-white shadow" />
          </button>
          <div className="min-w-0 flex-1">
            <p className={`truncate text-[13px] font-[600] ${r.enabled ? "text-fg" : "text-fg-subtle"}`}>{r.title}</p>
            <p className="truncate text-[12px] text-fg-muted">{r.nextRunAt ? relTime(r.nextRunAt) : r.schedule}</p>
          </div>
          <button onClick={() => remove.mutate(r.id)} title="Smazat" aria-label="Smazat rutinu" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:text-danger md:hidden md:group-hover:flex md:focus-visible:flex">
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

function IdentityTab({ agent, onOpenSoul, onOpenUserProfile, onOpenMemory, onRename }: { agent: Agent; onOpenSoul: () => void; onOpenUserProfile: () => void; onOpenMemory: () => void; onRename: (n: string) => void }) {
  const queryClient = useQueryClient();
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

      <ProfileForm agent={agent} />

      <div className="space-y-2">
        <button onClick={onOpenSoul} className="pressable flex w-full items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3 text-left hover:bg-bg-hover">
          <Fingerprint size={16} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-[600] text-fg">SOUL.md — duše agenta</span>
            <span className="block text-[12px] text-fg-muted">Kým je · upravitelná · od {fmtDate(agent.createdAt)}</span>
          </span>
        </button>
        <button onClick={onOpenUserProfile} className="pressable flex w-full items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3 text-left hover:bg-bg-hover">
          <User size={16} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-[600] text-fg">USER.md — obraz uživatele</span>
            <span className="block text-[12px] text-fg-muted">{agent.userProfile?.trim() ? "Profil vyplněn" : "Zatím prázdný — agent doplní z konverzace"}</span>
          </span>
        </button>
        <button onClick={onOpenMemory} className="pressable flex w-full items-center gap-3 rounded-[16px] border border-border bg-bg-raised px-4 py-3 text-left hover:bg-bg-hover">
          <Brain size={16} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-[600] text-fg">Paměť</span>
            <span className="block text-[12px] text-fg-muted">{(memory?.atoms.length ?? 0) + (memory?.notes.length ?? 0)} záznamů</span>
          </span>
        </button>
      </div>

      <div className="rounded-[16px] border border-border bg-bg-raised px-4 py-3 text-[12.5px] leading-relaxed text-fg-muted">
        <p className="flex items-center gap-1.5"><Check size={13} className="text-live" /> Počítač: {agent.isolated ? "izolovaný kontejner" : "místní běh"}</p>
      </div>
    </div>
  );
}

/**
 * Plnohodnotný editovatelný profil identity: charakter, vibe a avatar.
 * Jméno se edituje inline v kartě nad formulářem.
 */
function ProfileForm({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [character, setCharacter] = useState(agent.character ?? "");
  const [vibe, setVibe] = useState(agent.vibe ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const dirty = character !== (agent.character ?? "") || vibe !== (agent.vibe ?? "");

  const save = useMutation({
    mutationFn: () => api.patch(`/agents/${agent.id}`, {
      character: character.trim() ? character.trim() : null,
      vibe: vibe.trim() ? vibe.trim() : null,
    }),
    onSuccess: () => {
      setErr(null);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2000);
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Uložení selhalo"),
  });

  const regenerate = useMutation({
    mutationFn: () => api.post(`/agents/${agent.id}/avatar/regenerate`),
    onSuccess: () => {
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Regenerace selhala"),
  });

  return (
    <div className="space-y-2.5 rounded-[16px] border border-border bg-bg-raised p-3.5">
      <div className="flex items-center gap-3">
        <AgentAvatar seed={agent.id} version={avatarVersionOf(agent)} size={44} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-[600] text-fg">Avatar</p>
          <p className="text-[12px] text-fg-muted">Jedinečný vizuální motiv agenta</p>
        </div>
        <button
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
          className="pressable flex items-center gap-1.5 rounded-full border border-border bg-bg-sunken px-3.5 py-2 text-[12.5px] font-[600] text-fg hover:bg-bg-hover disabled:opacity-40"
        >
          <RefreshCw size={13} className={regenerate.isPending ? "animate-spin" : ""} />
          {regenerate.isPending ? "Generuji…" : "Nový avatar"}
        </button>
      </div>

      <label className="block">
        <span className="mb-1 block px-1 text-[12px] font-[600] text-fg-muted">Charakter — kým agent je</span>
        <input
          value={character}
          onChange={(e) => setCharacter(e.target.value)}
          placeholder="např. trpělivý průvodce, co věci dotahuje do konce"
          maxLength={200}
          className="h-10 w-full rounded-full border border-border bg-bg-sunken px-4 text-[13px] text-fg outline-none focus:border-accent"
        />
      </label>
      <label className="block">
        <span className="mb-1 block px-1 text-[12px] font-[600] text-fg-muted">Vibe — jak působí</span>
        <input
          value={vibe}
          onChange={(e) => setVibe(e.target.value)}
          placeholder="např. klidný, vtipný, přímý"
          maxLength={200}
          className="h-10 w-full rounded-full border border-border bg-bg-sunken px-4 text-[13px] text-fg outline-none focus:border-accent"
        />
      </label>

      {err && <p className="px-1 text-[12px] text-danger">{err}</p>}
      {savedTick && !dirty && <p className="px-1 text-[12px] font-[600] text-live">Uloženo</p>}
      {dirty && (
        <button onClick={() => save.mutate()} disabled={save.isPending} className="pressable w-full rounded-full bg-accent py-2 text-[13px] font-[600] text-white disabled:opacity-40">
          {save.isPending ? "Ukládám…" : "Uložit profil"}
        </button>
      )}
    </div>
  );
}
