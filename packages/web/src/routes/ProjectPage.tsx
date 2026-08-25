import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, Bot, ChevronDown, Clock, Folder, ListTodo, Plus, UserPlus, Users, Video, ArrowLeft, Layers, MessageSquare, FileCode } from "lucide-react";
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
const TASK_STATUS_LABEL: Record<HertzTask["status"], string> = { open: "Open", in_progress: "In progress", done: "Done" };

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
      <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
      {!fixedRole && (<div><Label>Role</Label><select value={role} onChange={(e) => setRole(e.target.value as AgentRole)} className="h-9 w-full rounded-[12px] border border-border bg-bg-raised px-3 text-[14px] text-fg outline-none focus:border-border-strong"><option value="" disabled>Select role</option>{AGENT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></div>)}
      <div><Label>Provider</Label><select value={providerConfigId} onChange={(e) => { setProviderConfigId(e.target.value); setModel(""); }} required className="h-9 w-full rounded-[12px] border border-border bg-bg-raised px-3 text-[14px] text-fg outline-none focus:border-border-strong"><option value="">Select a provider…</option>{providers?.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
      <div><Label>Model</Label><ModelPicker providerConfigId={providerConfigId} value={model} onChange={setModel} /></div>
      <Button type="submit" variant="primary" disabled={createAgent.isPending || !model}>{createAgent.isPending ? "Creating…" : fixedRole === "manager" ? "Set up manager" : "Create agent"}</Button>
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
      {/* Header — breadcrumb + title, not centered, editorial */}
      <div className="shrink-0 border-b border-border bg-bg">
        <div className="container-app py-5">
          <button onClick={() => navigate("/")} className="mb-3 flex items-center gap-1.5 text-[13px] font-[500] text-fg-muted hover:text-fg">
            <ArrowLeft size={14} strokeWidth={1.9} /> Projects
          </button>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-serif text-[24px] font-[600] tracking-[-0.025em] leading-none text-fg md:text-[26px]">{project?.name ?? "—"}</h1>
              <p className="mono mt-1.5 max-w-[60ch] truncate text-[12.5px] text-fg-subtle">{project?.roots[0]?.absolutePath ?? ""}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowAgentForm(true)}><Plus size={13} /> New agent</Button>
            </div>
          </div>
        </div>
        {/* Tabs — underline style, pro system like Vercel/Linear */}
        <div className="container-app">
          <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
            <Tabs.List className="flex gap-5 overflow-x-auto border-b border-transparent scrollbar-none">
              {[
                { v: "overview", l: "Overview", c: agents.length },
                { v: "team", l: "Team", c: agents.length },
                { v: "work", l: "Work", c: tasks.length + routines.length },
                { v: "discussions", l: "Discussions", c: meetings.length + conversations.length },
                { v: "files", l: "Files" },
              ].map((t) => (
                <Tabs.Trigger key={t.v} value={t.v} className={`shrink-0 border-b-2 px-0.5 py-3 text-[13.5px] font-[550] tracking-[-0.01em] transition-colors ${activeTab === t.v ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>
                  <span className="flex items-center gap-2">{t.l} {t.c !== undefined && t.c > 0 && <span className={`rounded-[7px] px-1.5 py-0.5 text-[11px] font-[600] leading-none ${activeTab === t.v ? "bg-bg-sunken text-fg" : "bg-bg-sunken text-fg-subtle"}`}>{t.c}</span>}</span>
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs.Root>
        </div>
      </div>

      <div className="container-app flex-1 py-6">
        {/* OVERVIEW */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {user?.role === "admin" && projectId && <ProjectAccessSection projectId={projectId} />}
            {project && (
              <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div>
                  <p className="text-[13.5px] font-[600] tracking-[-0.01em] text-fg">Auto-approve manager requests</p>
                  <p className="mt-0.5 max-w-[56ch] text-[13px] leading-relaxed text-fg-muted">When on, hires and firings take effect immediately instead of waiting for approval.</p>
                </div>
                <Button variant={project.autoApprove ? "primary" : "secondary"} size="sm" onClick={() => toggleAutoApprove.mutate(!project.autoApprove)} disabled={toggleAutoApprove.isPending}>{project.autoApprove ? "On" : "Off"}</Button>
              </Card>
            )}
            {!manager && !showManagerForm && (
              <Card><EmptyState icon={<Bot size={22} strokeWidth={1.6} />} title="No manager yet" description="The manager hires and briefs employees, delegates work and reports back. Set one up to get a real team." action={<Button variant="primary" onClick={() => setShowManagerForm(true)}><Plus size={14} /> Set up manager</Button>} /></Card>
            )}
            {!manager && showManagerForm && (<Card className="p-5"><h2 className="mb-3 font-serif text-[16px] font-[600] tracking-[-0.015em] text-fg">Set up your manager</h2><NewAgentForm projectId={projectId!} fixedRole="manager" onCreated={() => setShowManagerForm(false)} /></Card>)}
            {manager && (
              <div>
                <h2 className="mb-2 text-[12px] font-[600] tracking-[-0.01em] text-fg-subtle">Manager</h2>
                <Card className="flex items-center justify-between p-3">
                  <button onClick={() => navigate(`/projects/${projectId}/agents/${manager.id}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Avatar label={manager.name} color={agentColor(manager.id)} />
                    <span className="min-w-0"><span className="block truncate text-[14px] font-[600] tracking-[-0.01em] text-fg">{manager.name}</span><span className="mono block truncate text-[12px] text-fg-subtle">{manager.lastStatus ?? manager.model}</span></span>
                    <Badge>Manager</Badge>
                  </button>
                  <span className="flex items-center gap-1.5">
                    <IconButton title="Memory" onClick={() => setMemoryAgent({ id: manager.id, name: manager.name })}><BrainCircuit size={15} strokeWidth={1.7} /></IconButton>
                    <DeleteButton title="Remove manager" onDelete={() => deleteAgent.mutate(manager.id)} />
                  </span>
                </Card>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Card className="p-4"><div className="flex items-center gap-2 text-fg-subtle"><Layers size={14} strokeWidth={1.7} /><span className="text-[12px] font-[600] tracking-wide text-fg-subtle">Team</span></div><p className="mt-2 font-serif text-[22px] font-[600] tracking-[-0.02em] text-fg">{agents.length}</p><p className="text-[12.5px] text-fg-muted">{employees.length} employees · {pendingTerminations.length} pending</p></Card>
              <Card className="p-4"><div className="flex items-center gap-2 text-fg-subtle"><ListTodo size={14} strokeWidth={1.7} /><span className="text-[12px] font-[600] tracking-wide text-fg-subtle">Work</span></div><p className="mt-2 font-serif text-[22px] font-[600] tracking-[-0.02em] text-fg">{tasks.length}</p><p className="text-[12.5px] text-fg-muted">{tasks.filter(t=>t.status!=="done").length} open · {routines.length} routines</p></Card>
              <Card className="p-4"><div className="flex items-center gap-2 text-fg-subtle"><MessageSquare size={14} strokeWidth={1.7} /><span className="text-[12px] font-[600] tracking-wide text-fg-subtle">Discussions</span></div><p className="mt-2 font-serif text-[22px] font-[600] tracking-[-0.02em] text-fg">{meetings.length + conversations.length}</p><p className="text-[12.5px] text-fg-muted">{meetings.length} meetings · {conversations.length} dms</p></Card>
            </div>
            {pendingTerminations.length > 0 && (
              <div>
                <h3 className="mb-2 text-[12px] font-[600] text-fg-subtle">Pending terminations · {pendingTerminations.length}</h3>
                <ul className="space-y-2">{pendingTerminations.map((a) => (
                  <li key={a.id}><Card className="flex flex-wrap items-center justify-between gap-3 p-3"><span className="flex items-center gap-3"><Avatar label={a.name} color={agentColor(a.id)} /><span className="text-[13.5px] font-[550] text-fg">{a.name} <span className="font-normal text-fg-subtle">· {ROLE_LABEL[a.role]}</span></span></span><span className="flex gap-1.5"><Button variant="danger" size="sm" onClick={() => decideTermination.mutate({ id: a.id, decision: "approved" })}>Confirm</Button><Button variant="ghost" size="sm" onClick={() => decideTermination.mutate({ id: a.id, decision: "rejected" })}>Keep</Button></span></Card></li>
                ))}</ul>
              </div>
            )}
          </div>
        )}

        {/* TEAM */}
        {activeTab === "team" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-serif text-[16px] font-[600] tracking-[-0.015em] text-fg">Team</h2>
              <span className="flex gap-1.5">
                <Button variant="secondary" size="sm" onClick={() => setShowAttachDialog(true)}><UserPlus size={13} /> Add existing</Button>
                <Button variant="secondary" size="sm" onClick={() => setShowGroupDialog(true)} disabled={agents.length < 1}><Users size={13} /> Group chat</Button>
                <Button variant="primary" size="sm" onClick={() => setShowAgentForm((v) => !v)}><Plus size={13} /> New agent</Button>
              </span>
            </div>
            {employees.length === 0 && !showAgentForm && <p className="rounded-[12px] border border-dashed border-border bg-bg-raised px-4 py-6 text-center text-[13.5px] text-fg-subtle">{manager ? "No employees yet — ask the manager to hire, or add one yourself." : "No employees yet."}</p>}
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {employees.map((a) => {
                const isAttached = a.projectId !== projectId;
                return (
                  <li key={a.id}><Card className="flex items-center gap-3 p-3 pr-2 hover:border-border-strong">
                    <button onClick={() => navigate(`/projects/${projectId}/agents/${a.id}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <Avatar label={a.name} color={agentColor(a.id)} />
                      <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-[600] tracking-[-0.01em] text-fg">{a.name}</span><span className="mono block truncate text-[11.5px] text-fg-subtle">{a.lastStatus ?? a.model}</span></span>
                    </button>
                    <span className="hidden items-center gap-1 sm:flex"><Badge>{ROLE_LABEL[a.role]}</Badge>{isAttached && <Badge>attached</Badge>}{a.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}</span>
                    <IconButton title="Memory" onClick={() => setMemoryAgent({ id: a.id, name: a.name })}><BrainCircuit size={14} strokeWidth={1.7} /></IconButton>
                    <DeleteButton title={isAttached ? "Remove from project" : "Delete"} onDelete={() => (isAttached ? detachAgent.mutate(a.id) : deleteAgent.mutate(a.id))} />
                  </Card></li>
                );
              })}
            </ul>
            {showAgentForm && <Card className="p-5"><h3 className="mb-3 text-[14px] font-[600] tracking-[-0.01em] text-fg">New agent</h3><NewAgentForm projectId={projectId!} onCreated={() => setShowAgentForm(false)} /></Card>}
          </div>
        )}

        {/* WORK: tasks + routines */}
        {activeTab === "work" && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center justify-between"><h2 className="font-serif text-[15px] font-[600] tracking-[-0.015em] text-fg">Tasks</h2><Button variant="secondary" size="sm" onClick={() => setShowTaskDialog(true)} disabled={employees.length < 1}><Plus size={13} /> New task</Button></div>
              {tasks.length === 0 ? <p className="rounded-[12px] border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-subtle">Create a task and pick assignees — everyone else stays untouched.</p> : <ul className="space-y-2">{tasks.map((t) => <li key={t.id}><TaskCard projectId={projectId!} task={t} onDelete={() => deleteTask.mutate(t.id)} onCycleStatus={() => cycleTaskStatus.mutate({ id: t.id, status: NEXT_TASK_STATUS[t.status] })} /></li>)}</ul>}
            </div>
            <div>
              <div className="mb-3 flex items-center justify-between"><h2 className="font-serif text-[15px] font-[600] tracking-[-0.015em] text-fg">Routines</h2><Button variant="secondary" size="sm" onClick={() => setShowRoutineDialog(true)} disabled={employees.length < 1}><Plus size={13} /> New routine</Button></div>
              {routineNotice && <p className="mb-3 flex items-center gap-1.5 rounded-[10px] border border-border bg-bg-sunken px-3 py-2 text-[12.5px] text-fg-muted"><Clock size={12} /> Created {routineNotice}</p>}
              {routines.length === 0 ? <p className="rounded-[12px] border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-subtle">Same brief, on a schedule — daily or cron.</p> : <ul className="space-y-2">{routines.map((r) => (
                <li key={r.id}><Card className="flex items-center justify-between gap-3 p-3"><span className="flex min-w-0 items-center gap-2.5"><Clock size={14} className="shrink-0 text-fg-subtle" strokeWidth={1.7} /><span className="min-w-0"><span className="block truncate text-[13.5px] font-[550] text-fg">{r.title}</span><span className="mono block truncate text-[11.5px] text-fg-subtle">{r.agentName} · {r.schedule}</span></span>{!r.enabled && <Badge>off</Badge>}</span><span className="flex gap-1.5"><Button variant="secondary" size="sm" onClick={() => toggleRoutine.mutate({ id: r.id, enabled: !r.enabled })}>{r.enabled ? "Pause" : "Resume"}</Button><DeleteButton title="Delete routine" onDelete={() => deleteRoutine.mutate(r.id)} /></span></Card></li>
              ))}</ul>}
            </div>
          </div>
        )}

        {/* DISCUSSIONS */}
        {activeTab === "discussions" && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center justify-between"><h2 className="font-serif text-[15px] font-[600] tracking-[-0.015em] text-fg">Meetings</h2><Button variant="secondary" size="sm" onClick={() => setShowMeetingDialog(true)} disabled={employees.length < 1}><Plus size={13} /> Convene</Button></div>
              {meetings.length === 0 ? <p className="rounded-[12px] border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-subtle">Pull agents into a shared conversation — like a call.</p> : <ul className="space-y-2">{meetings.map((m) => (
                <li key={m.id}><button onClick={() => navigate(`/projects/${projectId}/meetings/${m.id}`)} className="group flex w-full items-center gap-3 rounded-[12px] border border-border bg-bg-raised p-3 text-left hover:border-border-strong hover:shadow-sm"><Video size={14} className="shrink-0 text-fg-subtle" strokeWidth={1.7} /><span className="min-w-0 flex-1 truncate text-[13.5px] font-[500] text-fg">{m.title}</span><Badge tone={m.status === "active" ? "accent" : "neutral"}>{m.status}</Badge><span className="hidden group-hover:block" onClick={(e) => e.stopPropagation()}><DeleteButton title="Delete meeting" onDelete={() => deleteMeeting.mutate(m.id)} /></span></button></li>
              ))}</ul>}
            </div>
            <div>
              <h2 className="mb-3 font-serif text-[15px] font-[600] tracking-[-0.015em] text-fg">Direct messages</h2>
              {conversations.length === 0 ? <p className="rounded-[12px] border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-subtle">No DMs yet — they appear when agents talk 1:1.</p> : <Card className="space-y-0.5 p-2">{conversations.map((c) => (
                <Link key={c.id} to={`/projects/${projectId}/sessions/${c.id}`} className="flex items-start gap-2.5 rounded-[10px] px-2.5 py-2 hover:bg-bg-sunken">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: agentColor(c.peerAgentId) }} />
                  <span className="min-w-0 flex-1 leading-snug"><span className="text-[13px] font-[600] tracking-[-0.01em] text-fg" style={{ color: agentColor(c.peerAgentId) }}>{c.peerAgentName ?? c.title}</span> <span className="text-[13px] text-fg-muted">{c.lastMessagePreview}</span></span>
                </Link>
              ))}</Card>}
              <div className="mt-4 flex gap-2"><Button variant="secondary" size="sm" onClick={() => setShowGroupDialog(true)} disabled={agents.length < 1}><Users size={13} /> New group chat</Button></div>
            </div>
          </div>
        )}

        {/* FILES */}
        {activeTab === "files" && (
          <div className="overflow-hidden rounded-[16px] border border-border bg-bg-raised">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <FileCode size={14} strokeWidth={1.7} className="text-fg-subtle" />
              <span className="text-[13px] font-[600] tracking-[-0.01em] text-fg">Files</span>
              <span className="mono ml-auto text-[11.5px] text-fg-subtle">{project?.roots[0]?.absolutePath}</span>
            </div>
            <div className="min-h-[420px]"><FileExplorer projectId={projectId!} /></div>
          </div>
        )}
      </div>

      {/* Dialogs */}
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
        <span className="flex min-w-0 items-start gap-2.5"><ListTodo size={14} className="mt-0.5 shrink-0 text-fg-subtle" strokeWidth={1.7} /><span className="min-w-0"><span className="block truncate text-[13.5px] font-[550] tracking-[-0.01em] text-fg">{task.title}</span>{!expanded && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-relaxed text-fg-subtle">{task.description}</span>}{expanded && <span className="mono block text-[11px] text-fg-subtle">{new Date(task.createdAt).toLocaleString()}</span>}</span></span>
        <span className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}><span onClick={onCycleStatus}><Badge tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Badge></span><DeleteButton title="Delete task" onDelete={onDelete} /><ChevronDown size={14} className={`text-fg-subtle transition-transform ${expanded ? "rotate-180" : ""}`} strokeWidth={1.7} /></span>
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-border bg-bg-sunken/40 p-3">
          <div><p className="mb-1.5 text-[11px] font-[600] tracking-wide text-fg-subtle">Brief</p><pre className="whitespace-pre-wrap rounded-[10px] border border-border bg-bg-raised p-3 text-[12.5px] leading-relaxed text-fg-muted">{d.description}</pre></div>
          <div><p className="mb-1 text-[11px] font-[600] tracking-wide text-fg-subtle">Timeline</p><p className="text-[12.5px] text-fg-subtle">Started {new Date(d.createdAt).toLocaleString()} · updated {new Date(d.updatedAt).toLocaleString()}</p></div>
          <div><p className="mb-1.5 text-[11px] font-[600] tracking-wide text-fg-subtle">Assignees & work log</p>{d.assignees.length === 0 ? <p className="text-[12.5px] text-fg-subtle">No assignees.</p> : <ul className="space-y-2">{d.assignees.map((a) => (
            <li key={a.id} className="rounded-[10px] border border-border bg-bg-raised px-3 py-2.5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[12.5px] font-[500] text-fg"><span className="flex h-6 w-6 items-center justify-center rounded-[8px] bg-bg-sunken text-[11px] font-[600] text-fg-muted">{a.agentName.slice(0, 1).toUpperCase()}</span>{a.agentName} <span className="font-normal text-fg-subtle">· {a.agentRole}</span></span>
                <span className="flex gap-1.5">{a.sessionId && <><SessionActions sessionId={a.sessionId} /><Button size="sm" variant="secondary" onClick={() => navigate(`/projects/${projectId}/sessions/${a.sessionId}`)}>Open chat</Button></>}</span>
              </div>
              {a.sessionId ? <SessionActivity sessionId={a.sessionId} /> : <p className="text-[12.5px] text-fg-subtle">Not started.</p>}
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
  if (!data) return <p className="text-[12.5px] text-fg-subtle">Loading…</p>;
  const events: string[] = [];
  for (const m of [...data.messages].reverse()) { for (const b of m.content ?? []) { if (b.type === "tool_use" && b.name) events.push(`→ ${b.name}`); else if (b.type === "tool_result") events.push(`  ${(b as unknown as { content?: string }).content?.slice(0, 90) ?? ""}`); else if (b.type === "text" && m.role === "assistant" && b.text) events.push(`✓ ${b.text.replace(/\s+/g, " ").slice(0, 110)}`); } if (events.length >= 14) break; }
  return (<div><p className="mb-1 text-[11px] text-fg-subtle">status <span className="font-[600] text-fg">{data.running ? "running" : data.session.status}</span> · {new Date(data.session.updatedAt).toLocaleTimeString()}</p><pre className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-[10px] border border-border bg-bg-sunken p-2 text-[11px] leading-relaxed text-fg-muted">{events.length ? events.join("\n") : "(no steps yet)"}</pre></div>);
}
function SessionActions({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const act = useMutation({ mutationFn: ({ action }: { action: string }) => api.post(`/sessions/${sessionId}/${action}`), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["task-session", sessionId] }); } });
  return (<><IconButton title="Pause" onClick={() => act.mutate({ action: "pause" })}>⏸</IconButton><IconButton title="Stop" onClick={() => act.mutate({ action: "stop" })}>■</IconButton><IconButton title="Nudge" onClick={() => api.post(`/sessions/${sessionId}/messages`, { text: "[Continue working on your assigned task until it is fully done.]" })}>▶</IconButton></>);
}
function NewGroupChatDialog({ open, onOpenChange, projectId, agents }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; agents: Agent[] }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const create = useMutation({ mutationFn: () => api.post<{ id: string }>(`/projects/${projectId}/group-chats`, { title: title.trim() || "Group chat", agentIds: [...selected] }), onSuccess: (created) => { void queryClient.invalidateQueries({ queryKey: ["sessions"] }); onOpenChange(false); setTitle(""); setSelected(new Set()); navigate(`/projects/${projectId}/sessions/${created.id}`); } });
  function toggle(id: string) { setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal><Dialog.Overlay className="fixed inset-0 bg-bg-overlay backdrop-blur-[4px]" /><Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-border bg-bg-raised p-5 shadow-popover">
        <Dialog.Title className="font-serif text-[16px] font-[600] tracking-[-0.015em] text-fg">New group chat</Dialog.Title><Dialog.Description className="mb-4 mt-1 text-[13px] leading-relaxed text-fg-muted">Pick the bots that share one thread — they answer together, @mention to address one.</Dialog.Description>
        <Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Launch crew" />
        <p className="mb-2 mt-4 text-[12px] font-[600] text-fg-muted">Participants · {selected.size}</p>
        <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">{agents.map((a) => (
          <li key={a.id}><button onClick={() => toggle(a.id)} className={`flex w-full items-center gap-3 rounded-[12px] border px-3 py-2.5 text-left ${selected.has(a.id) ? "border-fg bg-fg text-bg" : "border-border hover:border-border-strong hover:bg-bg-hover"}`}><Avatar label={a.name} color={agentColor(a.id)} /><span className="min-w-0 flex-1"><span className={`block truncate text-[13.5px] font-[550] ${selected.has(a.id) ? "text-bg" : "text-fg"}`}>{a.name}</span><span className={`block truncate text-[12px] ${selected.has(a.id) ? "text-bg/70" : "text-fg-subtle"}`}>{ROLE_LABEL[a.role]}</span></span>{selected.has(a.id) && <Badge className="bg-bg text-fg">in</Badge>}</button></li>
        ))}</ul>
        <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" size="sm" disabled={selected.size === 0 || create.isPending} onClick={() => create.mutate()}>Create</Button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  );
}
