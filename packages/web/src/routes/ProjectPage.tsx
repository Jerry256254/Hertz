import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, Bot, ChevronDown, Clock, ListTodo, Plus, UserPlus, Users, Video, ArrowLeft, Layers, MessageSquare, FileCode, Hash } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, AgentRole, ConversationSummary, HertzTask, Meeting, Project, ProviderConfig, Routine } from "../lib/types";
import { AGENT_ROLES, ROLE_LABEL } from "../lib/types";
import { agentColor } from "../lib/agent-color";
import { useAuth } from "../lib/auth";
import { ProjectAccessSection } from "../components/ProjectAccessSection";
import { FileExplorer } from "../components/FileExplorer";
import { Avatar, Badge, Button, Card, EmptyState, IconButton, Input, Label } from "../components/ui";
import { NewMeetingDialog } from "../components/NewMeetingDialog";
import { NewTaskDialog } from "../components/NewTaskDialog";
import { NewRoutineDialog } from "../components/NewRoutineDialog";
import { DeleteButton } from "../components/DeleteButton";
import { AgentMemoryDialog } from "../components/AgentMemoryDialog";
import { AttachEmployeeDialog } from "../components/AttachEmployeeDialog";
import { ModelPicker } from "../components/ModelPicker";

const TASK_STATUS_TONE: Record<HertzTask["status"], "neutral" | "accent" | "success"> = { open: "neutral", in_progress: "accent", done: "success" };
const TASK_STATUS_LABEL: Record<HertzTask["status"], string> = { open: "Otevřeno", in_progress: "Rozpracováno", done: "Hotovo" };

function NewAgentForm({ projectId, fixedRole, onCreated }: { projectId: string; fixedRole?: "manager"; onCreated: () => void }) {
  const queryClient = useQueryClient();
  const { data: providers } = useQuery({ queryKey: ["providers"], queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers") });
  const [name, setName] = useState(fixedRole === "manager" ? "Manager" : "agent-1");
  const [role, setRole] = useState<AgentRole>(fixedRole === "manager" ? "manager" : "implementer");
  const [providerConfigId, setProviderConfigId] = useState("");
  const [model, setModel] = useState("");
  const createAgent = useMutation({
    mutationFn: () => api.post<{ id: string }>("/agents", { projectId, name, role: fixedRole ?? role, providerConfigId, model }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["agents", projectId] }); onCreated(); },
  });
  function onSubmit(e: FormEvent) { e.preventDefault(); if (!model) return; createAgent.mutate(); }
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div><Label>JMÉNO</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
      {!fixedRole && (<div><Label>ROLE</Label><select value={role} onChange={(e) => setRole(e.target.value as AgentRole)} className="h-[36px] w-full rounded-md border border-border bg-bg-raised px-3 text-[13px] text-fg outline-none focus:border-fg"><option value="" disabled>Vyber roli</option>{AGENT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></div>)}
      <div><Label>PROVIDER</Label><select value={providerConfigId} onChange={(e) => { setProviderConfigId(e.target.value); setModel(""); }} required className="h-[36px] w-full rounded-md border border-border bg-bg-raised px-3 text-[13px] text-fg outline-none focus:border-fg"><option value="">Vyber providera…</option>{providers?.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
      <div><Label>MODEL</Label><ModelPicker providerConfigId={providerConfigId} value={model} onChange={setModel} /></div>
      <Button type="submit" variant="primary" disabled={createAgent.isPending || !model} className="w-full">{createAgent.isPending ? "Zakládám…" : fixedRole === "manager" ? "Založit managera" : "Vytvořit agenta"}</Button>
    </form>
  );
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("overview");
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [showManagerForm, setShowManagerForm] = useState(false);
  const [showMeetingDialog, setShowMeetingDialog] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [showRoutineDialog, setShowRoutineDialog] = useState(false);
  const [routineNotice, setRoutineNotice] = useState<string | undefined>(undefined);
  const [showAttachDialog, setShowAttachDialog] = useState(false);
  const [memoryAgent, setMemoryAgent] = useState<{ id: string; name: string } | undefined>(undefined);

  const { data: project } = useQuery({ queryKey: ["project", projectId], queryFn: () => api.get<Project>(`/projects/${projectId}`) });
  const { data: agentsData } = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.get<{ agents: Agent[] }>(`/projects/${projectId}/agents`) });
  const { data: meetingsData } = useQuery({ queryKey: ["meetings", projectId], queryFn: () => api.get<{ meetings: Meeting[] }>(`/projects/${projectId}/meetings`) });
  const { data: tasksData } = useQuery({ queryKey: ["tasks", projectId], queryFn: () => api.get<{ tasks: HertzTask[] }>(`/projects/${projectId}/tasks`) });
  const { data: routinesData } = useQuery({ queryKey: ["routines", projectId], queryFn: () => api.get<{ routines: Routine[] }>(`/projects/${projectId}/routines`) });
  const { data: conversationsData } = useQuery({ queryKey: ["conversations", projectId], queryFn: () => api.get<{ conversations: ConversationSummary[] }>(`/projects/${projectId}/conversations`), refetchInterval: 10000 });

  const deleteAgent = useMutation({ mutationFn: (agentId: string) => api.delete(`/agents/${agentId}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", projectId] }) });
  const detachAgent = useMutation({ mutationFn: (agentId: string) => api.delete(`/projects/${projectId}/agents/${agentId}/attach`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", projectId] }) });
  const deleteMeeting = useMutation({ mutationFn: (meetingId: string) => api.delete(`/meetings/${meetingId}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["meetings", projectId] }) });
  const cycleTaskStatus = useMutation({ mutationFn: ({ id, status }: { id: string; status: HertzTask["status"] }) => api.patch(`/tasks/${id}`, { status }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }) });
  const deleteTask = useMutation({ mutationFn: (id: string) => api.delete(`/tasks/${id}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }) });
  const agents = agentsData?.agents ?? [];
  const manager = agents.find((a) => a.role === "manager");
  const employees = agents.filter((a) => a.role !== "manager" && a.approvalStatus === "approved");
  const pendingTerminations = agents.filter((a) => a.pendingTermination);
  const decideTermination = useMutation({ mutationFn: ({ id, decision }: { id: string; decision: "approved" | "rejected" }) => api.patch(`/agents/${id}/termination`, { decision }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", projectId] }) });
  const toggleAutoApprove = useMutation({ mutationFn: (autoApprove: boolean) => api.patch(`/projects/${projectId}/auto-approve`, { autoApprove }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["project", projectId] }) });
  const meetings = meetingsData?.meetings ?? [];
  const tasks = tasksData?.tasks ?? [];
  const routines = routinesData?.routines ?? [];
  const conversations = conversationsData?.conversations ?? [];
  const toggleRoutine = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/routines/${id}`, { enabled }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["routines", projectId] }) });
  const deleteRoutine = useMutation({ mutationFn: (id: string) => api.delete(`/routines/${id}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["routines", projectId] }) });
  const NEXT_TASK_STATUS: Record<HertzTask["status"], HertzTask["status"]> = { open: "in_progress", in_progress: "done", done: "open" };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Masthead */}
      <div className="shrink-0 border-b border-border bg-bg-raised">
        <div className="container-app py-5">
          <button onClick={() => navigate("/")} className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 mono text-[11px] font-[600] tracking-[0.06em] text-fg-muted hover:border-border hover:bg-bg-sunken hover:text-fg">
            <ArrowLeft size={12} strokeWidth={1.9} /> PROJEKTY
          </button>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-display text-[28px] leading-none tracking-[-0.04em] text-fg md:text-[32px]">{project?.name ?? "—"}</h1>
              <div className="mt-2 flex items-center gap-2">
                <span className="mono max-w-[52ch] truncate rounded-sm border border-border bg-bg-sunken px-2 py-1 text-[11px] leading-none text-fg-muted">{project?.roots[0]?.absolutePath ?? ""}</span>
                <span className="hidden mono text-[10px] font-[600] tracking-[0.08em] text-fg-faint sm:inline">LOCAL FS</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={() => setShowAgentForm(true)}><Plus size={13} /> Nový agent</Button>
            </div>
          </div>
        </div>

        {/* segmented pill tabs */}
        <div className="container-app pb-3">
          <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
            <Tabs.List className="inline-flex gap-1 rounded-md border border-border bg-bg-sunken p-1">
              {[
                { v: "overview", l: "Přehled", c: undefined },
                { v: "team", l: "Tým", c: agents.length },
                { v: "work", l: "Práce", c: tasks.length + routines.length },
                { v: "discussions", l: "Diskuze", c: meetings.length + conversations.length },
                { v: "files", l: "Soubory" },
              ].map((t) => (
                <Tabs.Trigger
                  key={t.v}
                  value={t.v}
                  className={`rounded-md px-3 py-1.5 mono text-[11px] font-[700] tracking-[0.06em] transition-colors ${activeTab === t.v ? "bg-fg text-bg-raised shadow-xs" : "text-fg-muted hover:text-fg"}`}
                >
                  <span className="flex items-center gap-1.5">{t.l} {t.c !== undefined && t.c > 0 && <span className={`rounded-full px-1.5 py-0.5 mono text-[10px] font-[700] leading-none ${activeTab === t.v ? "bg-bg-raised text-fg" : "bg-bg-raised text-fg-subtle border border-border"}`}>{t.c}</span>}</span>
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs.Root>
        </div>
      </div>

      <div className="container-app flex-1 py-6">
        {activeTab === "overview" && (
          <div className="space-y-5">
            {user?.role === "admin" && projectId && <ProjectAccessSection projectId={projectId} />}

            {/* ledger stats */}
            <div className="overflow-hidden rounded-lg border border-border bg-bg-raised">
              <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
                <div className="p-4">
                  <div className="flex items-center gap-2 mono text-[10px] font-[700] tracking-[0.12em] text-fg-subtle"><Layers size={11} /> TÝM</div>
                  <p className="mt-1 text-[28px] font-[700] leading-none tracking-[-0.03em] text-fg">{agents.length}</p>
                  <p className="mono mt-1 text-[11px] leading-none text-fg-muted">{employees.length} zaměstnanců · {pendingTerminations.length} čeká</p>
                </div>
                <div className="p-4">
                  <div className="flex items-center gap-2 mono text-[10px] font-[700] tracking-[0.12em] text-fg-subtle"><ListTodo size={11} /> PRÁCE</div>
                  <p className="mt-1 text-[28px] font-[700] leading-none tracking-[-0.03em] text-fg">{tasks.length}</p>
                  <p className="mono mt-1 text-[11px] leading-none text-fg-muted">{tasks.filter(t=>t.status!=="done").length} otevřeno · {routines.length} rutin</p>
                </div>
                <div className="p-4">
                  <div className="flex items-center gap-2 mono text-[10px] font-[700] tracking-[0.12em] text-fg-subtle"><MessageSquare size={11} /> DISKUZE</div>
                  <p className="mt-1 text-[28px] font-[700] leading-none tracking-[-0.03em] text-fg">{meetings.length + conversations.length}</p>
                  <p className="mono mt-1 text-[11px] leading-none text-fg-muted">{meetings.length} mítinků · {conversations.length} DM</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-sunken px-4 py-3">
                <div>
                  <p className="text-[12.5px] font-[600] tracking-[-0.01em] text-fg">Automatické schvalování</p>
                  <p className="mono text-[11px] leading-relaxed text-fg-muted">Hiring a propouštění proběhne ihned bez čekání na schválení.</p>
                </div>
                <button
                  onClick={() => project && toggleAutoApprove.mutate(!project.autoApprove)}
                  disabled={toggleAutoApprove.isPending || !project}
                  className={`relative inline-flex h-6 w-10 items-center rounded-full border p-0.5 transition-colors ${project?.autoApprove ? "border-fg bg-fg" : "border-border bg-bg-raised"}`}
                >
                  <span className={`h-4 w-4 rounded-full bg-bg-raised shadow-xs transition-transform ${project?.autoApprove ? "translate-x-4 bg-bg-raised" : "translate-x-0 bg-fg"} ${project?.autoApprove ? "!bg-bg-raised" : ""}`} style={{ background: project?.autoApprove ? "var(--color-bg-raised)" : "var(--color-fg)" }} />
                </button>
              </div>
            </div>

            {!manager && !showManagerForm && (
              <Card className="border-dashed"><EmptyState icon={<Bot size={18} strokeWidth={1.6} />} title="Zatím žádný manager" description="Manager najímá a úkoluje lidi, deleguje práci a reportuje. Založ ho a budeš mít skutečný tým." action={<Button variant="primary" onClick={() => setShowManagerForm(true)}><Plus size={14} /> Založit managera</Button>} /></Card>
            )}
            {!manager && showManagerForm && (<Card className="p-5"><h2 className="mb-3 font-display text-[18px] leading-none tracking-[-0.03em] text-fg">Založit managera</h2><NewAgentForm projectId={projectId!} fixedRole="manager" onCreated={() => setShowManagerForm(false)} /></Card>)}
            {manager && (
              <div>
                <p className="mono mb-2 text-[10px] font-[700] tracking-[0.12em] text-fg-subtle">MANAGER</p>
                <Card className="flex items-center justify-between gap-3 border-l-[3px] border-l-fg p-3">
                  <button onClick={() => navigate(`/projects/${projectId}/agents/${manager.id}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Avatar label={manager.name} color={agentColor(manager.id)} />
                    <span className="min-w-0"><span className="block truncate text-[13.5px] font-[650] tracking-[-0.01em] text-fg">{manager.name}</span><span className="mono block truncate text-[11px] text-fg-subtle">{manager.lastStatus ?? manager.model}</span></span>
                    <Badge tone="accent">Manager</Badge>
                  </button>
                  <span className="flex items-center gap-1">
                    <IconButton title="Paměť" onClick={() => setMemoryAgent({ id: manager.id, name: manager.name })}><BrainCircuit size={15} strokeWidth={1.7} /></IconButton>
                    <DeleteButton title="Odebrat managera" onDelete={() => deleteAgent.mutate(manager.id)} />
                  </span>
                </Card>
              </div>
            )}

            {pendingTerminations.length > 0 && (
              <div>
                <h3 className="mono mb-2 text-[10px] font-[700] tracking-[0.12em] text-fg-subtle">KE SCHVÁLENÍ · UKONČENÍ · {pendingTerminations.length}</h3>
                <ul className="space-y-2">{pendingTerminations.map((a) => (
                  <li key={a.id}><Card className="flex flex-wrap items-center justify-between gap-3 p-3 border-warning/30 bg-warning-wash/40"><span className="flex items-center gap-3"><Avatar label={a.name} color={agentColor(a.id)} /><span className="text-[12.5px] font-[600] tracking-[-0.01em] text-fg">{a.name} <span className="mono font-normal text-fg-subtle">· {ROLE_LABEL[a.role]}</span></span></span><span className="flex gap-1.5"><Button variant="primary" size="sm" onClick={() => decideTermination.mutate({ id: a.id, decision: "approved" })}>Potvrdit</Button><Button variant="ghost" size="sm" onClick={() => decideTermination.mutate({ id: a.id, decision: "rejected" })}>Ponechat</Button></span></Card></li>
                ))}</ul>
              </div>
            )}
          </div>
        )}

        {activeTab === "team" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-[18px] leading-none tracking-[-0.03em] text-fg">Tým</h2>
              <span className="flex flex-wrap gap-1.5">
                <Button variant="secondary" size="sm" onClick={() => setShowAttachDialog(true)}><UserPlus size={13} /> Přidat existujícího</Button>
                <Button variant="secondary" size="sm" onClick={() => setShowGroupDialog(true)} disabled={agents.length < 1}><Users size={13} /> Skupinový chat</Button>
                <Button variant="primary" size="sm" onClick={() => setShowAgentForm((v) => !v)}><Plus size={13} /> Nový agent</Button>
              </span>
            </div>
            {employees.length === 0 && !showAgentForm && <p className="rounded-md border border-dashed border-border bg-bg-raised px-4 py-8 text-center mono text-[12px] text-fg-subtle">{manager ? "Zatím žádní zaměstnanci — požádej managera ať najme, nebo přidej sám." : "Zatím žádní zaměstnanci."}</p>}
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {employees.map((a) => {
                const isAttached = a.projectId !== projectId;
                return (
                  <li key={a.id}><Card className="overflow-hidden p-0">
                    <div className="h-1 w-full" style={{ background: agentColor(a.id) }} />
                    <div className="flex items-center gap-3 p-3">
                      <button onClick={() => navigate(`/projects/${projectId}/agents/${a.id}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                        <Avatar label={a.name} color={agentColor(a.id)} />
                        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-[650] tracking-[-0.01em] text-fg">{a.name}</span><span className="mono block truncate text-[11px] text-fg-subtle">{a.lastStatus ?? a.model}</span></span>
                      </button>
                      <span className="hidden items-center gap-1 sm:flex"><Badge>{ROLE_LABEL[a.role]}</Badge>{isAttached && <Badge tone="warning">připojen</Badge>}{a.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />}</span>
                      <IconButton title="Paměť" onClick={() => setMemoryAgent({ id: a.id, name: a.name })}><BrainCircuit size={14} strokeWidth={1.7} /></IconButton>
                      <DeleteButton title={isAttached ? "Odebrat z projektu" : "Smazat"} onDelete={() => (isAttached ? detachAgent.mutate(a.id) : deleteAgent.mutate(a.id))} />
                    </div>
                  </Card></li>
                );
              })}
            </ul>
            {showAgentForm && <Card className="p-5"><h3 className="mono mb-3 text-[11px] font-[700] tracking-[0.1em] text-fg">NOVÝ AGENT</h3><NewAgentForm projectId={projectId!} onCreated={() => setShowAgentForm(false)} /></Card>}
          </div>
        )}

        {activeTab === "work" && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center justify-between"><h2 className="font-display text-[16px] leading-none tracking-[-0.02em] text-fg">Úkoly</h2><Button variant="secondary" size="sm" onClick={() => setShowTaskDialog(true)} disabled={employees.length < 1}><Plus size={13} /> Nový úkol</Button></div>
              {tasks.length === 0 ? <p className="rounded-md border border-dashed border-border bg-bg-raised px-4 py-8 text-center mono text-[12px] text-fg-subtle">Vytvoř úkol a vyber řešitele — ostatní zůstanou nedotčeni.</p> : <ul className="space-y-2">{tasks.map((t) => <li key={t.id}><TaskCard projectId={projectId!} task={t} onDelete={() => deleteTask.mutate(t.id)} onCycleStatus={() => cycleTaskStatus.mutate({ id: t.id, status: NEXT_TASK_STATUS[t.status] })} /></li>)}</ul>}
            </div>
            <div>
              <div className="mb-3 flex items-center justify-between"><h2 className="font-display text-[16px] leading-none tracking-[-0.02em] text-fg">Rutiny</h2><Button variant="secondary" size="sm" onClick={() => setShowRoutineDialog(true)} disabled={employees.length < 1}><Plus size={13} /> Nová rutina</Button></div>
              {routineNotice && <p className="mb-3 flex items-center gap-1.5 rounded-md border border-border bg-bg-sunken px-3 py-2 mono text-[11px] text-fg-muted"><Clock size={11} /> Vytvořeno {routineNotice}</p>}
              {routines.length === 0 ? <p className="rounded-md border border-dashed border-border bg-bg-raised px-4 py-8 text-center mono text-[12px] text-fg-subtle">Stejné zadání podle plánu — denně nebo cron.</p> : <ul className="space-y-2">{routines.map((r) => (
                <li key={r.id}><Card className="flex items-center justify-between gap-3 p-3"><span className="flex min-w-0 items-center gap-2.5"><span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-bg-sunken text-fg-subtle"><Clock size={13} strokeWidth={1.7} /></span><span className="min-w-0"><span className="block truncate text-[12.5px] font-[600] tracking-[-0.01em] text-fg">{r.title}</span><span className="mono block truncate text-[11px] text-fg-subtle">{r.agentName} · {r.schedule}</span></span>{!r.enabled && <Badge tone="warning">vypnuto</Badge>}</span><span className="flex gap-1.5"><Button variant="secondary" size="sm" onClick={() => toggleRoutine.mutate({ id: r.id, enabled: !r.enabled })}>{r.enabled ? "Pozastavit" : "Spustit"}</Button><DeleteButton title="Smazat rutinu" onDelete={() => deleteRoutine.mutate(r.id)} /></span></Card></li>
              ))}</ul>}
            </div>
          </div>
        )}

        {activeTab === "discussions" && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center justify-between"><h2 className="font-display text-[16px] leading-none tracking-[-0.02em] text-fg">Mítinky</h2><Button variant="secondary" size="sm" onClick={() => setShowMeetingDialog(true)} disabled={employees.length < 1}><Plus size={13} /> Svolat</Button></div>
              {meetings.length === 0 ? <p className="rounded-md border border-dashed border-border bg-bg-raised px-4 py-8 text-center mono text-[12px] text-fg-subtle">Stáhni agenty do společné konverzace — jako hovor.</p> : <ul className="space-y-2">{meetings.map((m) => (
                <li key={m.id}><button onClick={() => navigate(`/projects/${projectId}/meetings/${m.id}`)} className="group flex w-full items-center gap-3 rounded-md border border-border bg-bg-raised p-3 text-left hover:border-fg hover:bg-bg-sunken"><span className="flex h-7 w-7 items-center justify-center rounded-md bg-fg text-bg-raised"><Video size={12} strokeWidth={1.7} /></span><span className="min-w-0 flex-1 truncate text-[13px] font-[500] tracking-[-0.01em] text-fg">{m.title}</span><Badge tone={m.status === "active" ? "live" : "neutral"}>{m.status}</Badge><span className="hidden group-hover:block" onClick={(e) => e.stopPropagation()}><DeleteButton title="Smazat mítink" onDelete={() => deleteMeeting.mutate(m.id)} /></span></button></li>
              ))}</ul>}
            </div>
            <div>
              <h2 className="mb-3 font-display text-[16px] leading-none tracking-[-0.02em] text-fg">Přímé zprávy</h2>
              {conversations.length === 0 ? <p className="rounded-md border border-dashed border-border bg-bg-raised px-4 py-8 text-center mono text-[12px] text-fg-subtle">Zatím žádné DM — objeví se, když si agenti píší 1:1.</p> : <Card className="space-y-0.5 p-2">{conversations.map((c) => (
                <Link key={c.id} to={`/projects/${projectId}/sessions/${c.id}`} className="flex items-start gap-2 rounded-md px-2.5 py-2 hover:bg-bg-sunken">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: agentColor(c.peerAgentId) }} />
                  <span className="min-w-0 flex-1 leading-snug"><span className="mono text-[11px] font-[700] tracking-[0.04em] text-fg" style={{ color: agentColor(c.peerAgentId) }}>{c.peerAgentName ?? c.title}</span> <span className="text-[12.5px] leading-relaxed text-fg-muted">{c.lastMessagePreview}</span></span>
                </Link>
              ))}</Card>}
              <div className="mt-4 flex gap-2"><Button variant="secondary" size="sm" onClick={() => setShowGroupDialog(true)} disabled={agents.length < 1}><Users size={13} /> Nový skupinový chat</Button></div>
            </div>
          </div>
        )}

        {activeTab === "files" && (
          <div className="overflow-hidden rounded-lg border border-border bg-bg-raised">
            <div className="flex items-center gap-2 border-b border-border bg-bg-sunken px-3 py-2.5">
              <span className="flex h-6 w-6 items-center justify-center rounded-sm bg-fg text-bg-raised"><FileCode size={12} strokeWidth={1.7} /></span>
              <span className="mono text-[11px] font-[700] tracking-[0.08em] text-fg">SOUBORY</span>
              <span className="mono ml-auto hidden text-[11px] text-fg-subtle md:block">{project?.roots[0]?.absolutePath}</span>
            </div>
            <div className="min-h-[420px]"><FileExplorer projectId={projectId!} /></div>
          </div>
        )}
      </div>

      <NewMeetingDialog open={showMeetingDialog} onOpenChange={setShowMeetingDialog} projectId={projectId!} agents={agents} onCreated={(meetingId) => navigate(`/projects/${projectId}/meetings/${meetingId}`)} />
      <NewTaskDialog open={showTaskDialog} onOpenChange={setShowTaskDialog} projectId={projectId!} agents={agents} />
      <NewGroupChatDialog open={showGroupDialog} onOpenChange={setShowGroupDialog} projectId={projectId!} agents={agents} />
      <NewRoutineDialog open={showRoutineDialog} onOpenChange={setShowRoutineDialog} projectId={projectId!} agents={employees} onCreated={(label) => { setRoutineNotice(label); setTimeout(() => setRoutineNotice(undefined), 6000); }} />
      <AttachEmployeeDialog open={showAttachDialog} onOpenChange={setShowAttachDialog} projectId={projectId!} currentTeamIds={new Set(agents.map((a) => a.id))} />
      {memoryAgent && <AgentMemoryDialog open={!!memoryAgent} onOpenChange={(open) => !open && setMemoryAgent(undefined)} agentId={memoryAgent.id} agentName={memoryAgent.name} />}
    </div>
  );
}

function TaskCard({ projectId, task, onCycleStatus, onDelete }: { projectId: string; task: HertzTask; onCycleStatus: () => void; onDelete: () => void }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const { data: detail } = useQuery({ queryKey: ["task", task.id], queryFn: () => api.get<HertzTask>(`/tasks/${task.id}`), enabled: expanded });
  const d = detail ?? task;
  return (
    <Card className="overflow-hidden p-0">
      <button onClick={() => setExpanded((v) => !v)} className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-bg-sunken/50">
        <span className="flex min-w-0 items-start gap-2.5"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-border bg-bg-sunken text-fg-subtle"><Hash size={12} strokeWidth={1.7} /></span><span className="min-w-0"><span className="block truncate text-[13px] font-[600] tracking-[-0.01em] text-fg">{task.title}</span>{!expanded && <span className="mt-0.5 line-clamp-2 block mono text-[11.5px] leading-relaxed text-fg-subtle">{task.description}</span>}{expanded && <span className="mono block text-[11px] text-fg-subtle">{new Date(task.createdAt).toLocaleString()}</span>}</span></span>
        <span className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}><span onClick={onCycleStatus}><Badge tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Badge></span><DeleteButton title="Smazat úkol" onDelete={onDelete} /><ChevronDown size={14} className={`text-fg-subtle transition-transform ${expanded ? "rotate-180" : ""}`} strokeWidth={1.7} /></span>
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-border bg-bg-sunken/40 p-3">
          <div><p className="mono mb-1.5 text-[10px] font-[700] tracking-[0.08em] text-fg-subtle">ZADÁNÍ</p><pre className="whitespace-pre-wrap rounded-md border border-border bg-bg-raised p-3 mono text-[11.5px] leading-relaxed text-fg-muted">{d.description}</pre></div>
          <div><p className="mono mb-1 text-[10px] font-[700] tracking-[0.08em] text-fg-subtle">ČAS</p><p className="mono text-[11px] text-fg-subtle">Založeno {new Date(d.createdAt).toLocaleString()} · aktualizováno {new Date(d.updatedAt).toLocaleString()}</p></div>
          <div><p className="mono mb-1.5 text-[10px] font-[700] tracking-[0.08em] text-fg-subtle">ŘEŠITELÉ</p>{d.assignees.length === 0 ? <p className="mono text-[11px] text-fg-subtle">Bez řešitele.</p> : <ul className="space-y-2">{d.assignees.map((a) => (
            <li key={a.id} className="rounded-md border border-border bg-bg-raised px-3 py-2.5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[12px] font-[600] tracking-[-0.01em] text-fg"><span className="flex h-6 w-6 items-center justify-center rounded-sm border border-border bg-bg-sunken mono text-[10px] font-[700] text-fg-muted">{a.agentName.slice(0, 1).toUpperCase()}</span>{a.agentName} <span className="mono font-normal text-fg-subtle">· {a.agentRole}</span></span>
                <span className="flex gap-1.5">{a.sessionId && <><SessionActions sessionId={a.sessionId} /><Button size="sm" variant="secondary" onClick={() => navigate(`/projects/${projectId}/sessions/${a.sessionId}`)}>Otevřít chat</Button></>}</span>
              </div>
              {a.sessionId ? <SessionActivity sessionId={a.sessionId} /> : <p className="mono text-[11px] text-fg-subtle">Nezačato.</p>}
            </li>
          ))}</ul>}</div>
        </div>
      )}
    </Card>
  );
}

interface SessionSnapshot { session: { status: string; createdAt: string; updatedAt: string }; running: boolean; messages: Array<{ id: string; role: string; senderAgentId: string | null; content: Array<{ type: string; text?: string; name?: string }> }>; }
function SessionActivity({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({ queryKey: ["task-session", sessionId], queryFn: () => api.get<SessionSnapshot>(`/sessions/${sessionId}`), refetchInterval: 4000 });
  if (!data) return <p className="mono text-[11px] text-fg-subtle">Načítám…</p>;
  const events: string[] = [];
  for (const m of [...data.messages].reverse()) { for (const b of m.content ?? []) { if (b.type === "tool_use" && b.name) events.push(`→ ${b.name}`); else if (b.type === "tool_result") events.push(`  ${(b as unknown as { content?: string }).content?.slice(0, 90) ?? ""}`); else if (b.type === "text" && m.role === "assistant" && b.text) events.push(`✓ ${b.text.replace(/\s+/g, " ").slice(0, 110)}`); } if (events.length >= 14) break; }
  return (<div><p className="mono mb-1 text-[10px] tracking-wide text-fg-subtle">stav <span className="font-[700] text-fg">{data.running ? "běží" : data.session.status}</span> · {new Date(data.session.updatedAt).toLocaleTimeString()}</p><pre className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-bg-sunken p-2 mono text-[11px] leading-relaxed text-fg-muted">{events.length ? events.join("\n") : "(zatím žádné kroky)"}</pre></div>);
}
function SessionActions({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const act = useMutation({ mutationFn: ({ action }: { action: string }) => api.post(`/sessions/${sessionId}/${action}`), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["task-session", sessionId] }); } });
  return (<><IconButton title="Pozastavit" onClick={() => act.mutate({ action: "pause" })}>⏸</IconButton><IconButton title="Zastavit" onClick={() => act.mutate({ action: "stop" })}>■</IconButton><IconButton title="Popostrčit" onClick={() => api.post(`/sessions/${sessionId}/messages`, { text: "[Pokračuj v práci na přiděleném úkolu, dokud není hotový.]" })}>▶</IconButton></>);
}
function NewGroupChatDialog({ open, onOpenChange, projectId, agents }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; agents: Agent[] }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const create = useMutation({ mutationFn: () => api.post<{ id: string }>(`/projects/${projectId}/group-chats`, { title: title.trim() || "Skupinový chat", agentIds: [...selected] }), onSuccess: (created) => { void queryClient.invalidateQueries({ queryKey: ["sessions"] }); onOpenChange(false); setTitle(""); setSelected(new Set()); navigate(`/projects/${projectId}/sessions/${created.id}`); } });
  function toggle(id: string) { setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal><Dialog.Overlay className="fixed inset-0 bg-bg-overlay backdrop-blur-[4px]" /><Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-raised p-5 shadow-popover">
        <Dialog.Title className="font-display text-[18px] leading-none tracking-[-0.03em] text-fg">Nový skupinový chat</Dialog.Title><Dialog.Description className="mb-4 mt-1 mono text-[12px] leading-relaxed text-fg-muted">Vyber boty do jednoho vlákna — odpovídají společně, @zmínkou oslovíš jednoho.</Dialog.Description>
        <Label>NÁZEV</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="např. Launch crew" />
        <p className="mono mb-2 mt-4 text-[10px] font-[700] tracking-[0.08em] text-fg-muted">ÚČASTNÍCI · {selected.size}</p>
        <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">{agents.map((a) => (
          <li key={a.id}><button onClick={() => toggle(a.id)} className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left ${selected.has(a.id) ? "border-fg bg-fg text-bg-raised" : "border-border hover:border-border-strong hover:bg-bg-sunken"}`}><Avatar label={a.name} color={agentColor(a.id)} /><span className="min-w-0 flex-1"><span className={`block truncate text-[13px] font-[600] ${selected.has(a.id) ? "text-bg-raised" : "text-fg"}`}>{a.name}</span><span className={`mono block truncate text-[11px] ${selected.has(a.id) ? "text-bg-raised/70" : "text-fg-subtle"}`}>{ROLE_LABEL[a.role]}</span></span>{selected.has(a.id) && <Badge className="bg-bg-raised text-fg">uvnitř</Badge>}</button></li>
        ))}</ul>
        <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Zrušit</Button><Button variant="primary" size="sm" disabled={selected.size === 0 || create.isPending} onClick={() => create.mutate()}>Vytvořit</Button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  );
}
