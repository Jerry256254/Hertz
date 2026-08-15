import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, Bot, Check, Clock, FolderGit2, ListTodo, MessageSquarePlus, Plus, Search, UserPlus, Video } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, AgentRole, EmployeeMessage, HertzTask, Meeting, ModelInfo, Project, ProviderConfig, Routine } from "../lib/types";
import { AGENT_ROLES, ROLE_LABEL } from "../lib/types";
import { agentColor } from "../lib/agent-color";
import { FileExplorer } from "../components/FileExplorer";
import { Avatar, Badge, Button, Card, EmptyState, IconButton, Input, Label } from "../components/ui";
import { NewMeetingDialog } from "../components/NewMeetingDialog";
import { NewTaskDialog } from "../components/NewTaskDialog";
import { NewRoutineDialog } from "../components/NewRoutineDialog";
import { DeleteButton } from "../components/DeleteButton";
import { AgentMemoryDialog } from "../components/AgentMemoryDialog";
import { AttachEmployeeDialog } from "../components/AttachEmployeeDialog";

const TASK_STATUS_TONE: Record<HertzTask["status"], "neutral" | "accent" | "success"> = {
  open: "neutral",
  in_progress: "accent",
  done: "success",
};

const TASK_STATUS_LABEL: Record<HertzTask["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
};

function ModelPicker({
  providerConfigId,
  value,
  onChange,
}: {
  providerConfigId: string;
  value: string;
  onChange: (modelId: string) => void;
}) {
  const [query, setQuery] = useState("");

  const modelsQuery = useQuery({
    queryKey: ["provider-models", providerConfigId],
    queryFn: () => api.post<{ models: ModelInfo[] }>(`/providers/${providerConfigId}/scan`),
    enabled: !!providerConfigId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const filtered = useMemo(() => {
    const models = modelsQuery.data?.models ?? [];
    const q = query.trim().toLowerCase();
    return q ? models.filter((m) => m.id.toLowerCase().includes(q)) : models;
  }, [modelsQuery.data, query]);

  if (!providerConfigId) {
    return <p className="text-xs text-fg-subtle">Select a provider first.</p>;
  }
  if (modelsQuery.isLoading) {
    return <p className="text-xs text-fg-muted">Scanning available models…</p>;
  }
  if (modelsQuery.isError) {
    return <p className="text-xs text-danger">{(modelsQuery.error as Error).message}</p>;
  }
  if (filtered.length === 0 && !query) {
    return <p className="text-xs text-fg-subtle">No models returned by this provider.</p>;
  }

  return (
    <div>
      {(modelsQuery.data?.models.length ?? 0) > 8 && (
        <div className="relative mb-2">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input
            placeholder="Filter models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      )}
      <div className="max-h-56 overflow-y-auto rounded-md border border-border">
        {filtered.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            className={`mono flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs ${
              value === m.id ? "bg-accent-wash text-accent" : "text-fg hover:bg-bg-hover"
            }`}
          >
            <span className="truncate">{m.id}</span>
            {value === m.id && <Check size={12} className="flex-shrink-0" />}
          </button>
        ))}
        {filtered.length === 0 && <p className="px-2.5 py-2 text-xs text-fg-subtle">No matches.</p>}
      </div>
    </div>
  );
}

function NewAgentForm({
  projectId,
  fixedRole,
  onCreated,
}: {
  projectId: string;
  fixedRole?: "manager";
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });
  const [name, setName] = useState(fixedRole === "manager" ? "Manager" : "agent-1");
  const [role, setRole] = useState<AgentRole>(fixedRole === "manager" ? "manager" : "implementer");
  const [providerConfigId, setProviderConfigId] = useState("");
  const [model, setModel] = useState("");

  const createAgent = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/agents", {
        projectId,
        name,
        role: fixedRole ?? role,
        providerConfigId,
        model,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agents", projectId] });
      onCreated();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!model) return;
    createAgent.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {!fixedRole && (
        <div>
          <Label>Role</Label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
            className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
          >
            {AGENT_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <Label>Provider</Label>
        <select
          value={providerConfigId}
          onChange={(e) => {
            setProviderConfigId(e.target.value);
            setModel("");
          }}
          required
          className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
        >
          <option value="">Select a provider…</option>
          {providers?.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label>Model</Label>
        <ModelPicker providerConfigId={providerConfigId} value={model} onChange={setModel} />
      </div>
      <Button type="submit" variant="primary" disabled={createAgent.isPending || !model}>
        {createAgent.isPending ? "Creating…" : fixedRole === "manager" ? "Set up manager" : "Create agent"}
      </Button>
    </form>
  );
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [showManagerForm, setShowManagerForm] = useState(false);
  const [showMeetingDialog, setShowMeetingDialog] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [showRoutineDialog, setShowRoutineDialog] = useState(false);
  const [routineNotice, setRoutineNotice] = useState<string | undefined>(undefined);
  const [showAttachDialog, setShowAttachDialog] = useState(false);
  const [memoryAgent, setMemoryAgent] = useState<{ id: string; name: string } | undefined>(undefined);

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
  });

  const { data: agentsData } = useQuery({
    queryKey: ["agents", projectId],
    queryFn: () => api.get<{ agents: Agent[] }>(`/projects/${projectId}/agents`),
  });

  const { data: meetingsData } = useQuery({
    queryKey: ["meetings", projectId],
    queryFn: () => api.get<{ meetings: Meeting[] }>(`/projects/${projectId}/meetings`),
  });

  const { data: tasksData } = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => api.get<{ tasks: HertzTask[] }>(`/projects/${projectId}/tasks`),
  });

  const { data: routinesData } = useQuery({
    queryKey: ["routines", projectId],
    queryFn: () => api.get<{ routines: Routine[] }>(`/projects/${projectId}/routines`),
  });

  const { data: teamMessagesData } = useQuery({
    queryKey: ["employee-messages", projectId],
    queryFn: () => api.get<{ messages: EmployeeMessage[] }>(`/projects/${projectId}/employee-messages`),
    refetchInterval: 10000,
  });

  const newChat = useMutation({
    mutationFn: (agentId: string) => api.post<{ id: string }>(`/agents/${agentId}/sessions`, { projectId }),
    onSuccess: (res) => navigate(`/projects/${projectId}/sessions/${res.id}`),
  });

  const deleteAgent = useMutation({
    mutationFn: (agentId: string) => api.delete(`/agents/${agentId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", projectId] }),
  });

  const detachAgent = useMutation({
    mutationFn: (agentId: string) => api.delete(`/projects/${projectId}/agents/${agentId}/attach`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", projectId] }),
  });

  const deleteMeeting = useMutation({
    mutationFn: (meetingId: string) => api.delete(`/meetings/${meetingId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["meetings", projectId] }),
  });

  const cycleTaskStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: HertzTask["status"] }) => api.patch(`/tasks/${id}`, { status }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }),
  });

  const deleteTask = useMutation({
    mutationFn: (id: string) => api.delete(`/tasks/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }),
  });

  const agents = agentsData?.agents ?? [];
  const manager = agents.find((a) => a.role === "manager");
  const employees = agents.filter((a) => a.role !== "manager" && a.approvalStatus === "approved");
  const pendingHires = agents.filter((a) => a.role !== "manager" && a.approvalStatus === "pending");

  const decideHire = useMutation({
    mutationFn: ({ id, approvalStatus }: { id: string; approvalStatus: "approved" | "rejected" }) =>
      api.patch(`/agents/${id}/approval`, { approvalStatus }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", projectId] }),
  });

  const meetings = meetingsData?.meetings ?? [];
  const tasks = tasksData?.tasks ?? [];
  const routines = routinesData?.routines ?? [];
  const teamMessages = teamMessagesData?.messages ?? [];

  const toggleRoutine = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/routines/${id}`, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["routines", projectId] }),
  });

  const deleteRoutine = useMutation({
    mutationFn: (id: string) => api.delete(`/routines/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["routines", projectId] }),
  });
  const NEXT_TASK_STATUS: Record<HertzTask["status"], HertzTask["status"]> = { open: "in_progress", in_progress: "done", done: "open" };

  return (
    <div className="grid h-full grid-cols-[1fr_320px]">
      <div className="overflow-auto px-6 py-6">
        <div className="mb-6 flex items-center gap-2">
          <FolderGit2 size={18} className="text-accent" />
          <div>
            <h1 className="text-base font-semibold leading-tight text-fg">{project?.name}</h1>
            <p className="mono text-xs leading-tight text-fg-subtle">{project?.roots[0]?.absolutePath}</p>
          </div>
        </div>

        {!manager && !showManagerForm && (
          <Card className="mb-6">
            <EmptyState
              icon={<Bot size={26} strokeWidth={1.5} />}
              title="This project has no manager yet"
              description="The manager runs point on this project for you — hires and briefs employees, delegates work, and reports back. Set one up to get a real team, not just a single chat."
              action={
                <Button variant="primary" onClick={() => setShowManagerForm(true)}>
                  <Plus size={14} /> Set up your manager
                </Button>
              }
            />
          </Card>
        )}
        {!manager && showManagerForm && (
          <Card className="mb-6 p-4">
            <h2 className="mb-3 text-sm font-semibold text-fg">Set up your manager</h2>
            <NewAgentForm projectId={projectId!} fixedRole="manager" onCreated={() => setShowManagerForm(false)} />
          </Card>
        )}

        {manager && (
          <div className="mb-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Manager</h2>
            <Card className="flex items-center justify-between p-3">
              <button
                onClick={() => navigate(`/projects/${projectId}/agents/${manager.id}`)}
                className="flex min-w-0 items-center gap-3 text-left hover:opacity-80"
              >
                <Avatar label={manager.name} color={agentColor(manager.id)} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">{manager.name}</p>
                  <p className="truncate text-xs text-fg-subtle" title={manager.model}>
                    {manager.lastStatus ?? <span className="mono">{manager.model}</span>}
                  </p>
                </div>
                <Badge tone="accent">Manager</Badge>
              </button>
              <div className="flex flex-shrink-0 items-center gap-2">
                <IconButton title="Memory" onClick={() => setMemoryAgent({ id: manager.id, name: manager.name })}>
                  <BrainCircuit size={15} />
                </IconButton>
                <Button variant="primary" size="sm" onClick={() => newChat.mutate(manager.id)} disabled={newChat.isPending}>
                  <MessageSquarePlus size={13} /> Chat
                </Button>
                <DeleteButton title="Remove manager" onDelete={() => deleteAgent.mutate(manager.id)} />
              </div>
            </Card>
          </div>
        )}

        {pendingHires.length > 0 && (
          <div className="mb-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Pending approval · {pendingHires.length}
            </h2>
            <ul className="space-y-2">
              {pendingHires.map((a) => (
                <li key={a.id}>
                  <Card className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <Avatar label={a.name} color={agentColor(a.id)} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-fg">
                            {a.name} <span className="font-normal text-fg-subtle">· {ROLE_LABEL[a.role]}</span>
                          </p>
                          {a.jobDescription && <p className="mt-0.5 text-xs text-fg-muted">{a.jobDescription}</p>}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => decideHire.mutate({ id: a.id, approvalStatus: "approved" })}
                          disabled={decideHire.isPending}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => decideHire.mutate({ id: a.id, approvalStatus: "rejected" })}
                          disabled={decideHire.isPending}
                        >
                          Reject
                        </Button>
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Team</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAttachDialog(true)}
              className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
            >
              <UserPlus size={13} /> Add existing
            </button>
            <button
              onClick={() => setShowAgentForm((v) => !v)}
              className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
            >
              <Plus size={13} /> New agent
            </button>
          </div>
        </div>

        {employees.length === 0 && !showAgentForm && (
          <p className="mb-3 text-sm text-fg-subtle">
            {manager ? "No employees yet — ask the manager to hire_employee, or add one yourself." : "No employees yet."}
          </p>
        )}

        <ul className="space-y-2">
          {employees.map((a) => {
            const isAttached = a.projectId !== projectId;
            return (
              <li key={a.id}>
                <Card className="flex items-center justify-between p-3">
                  <button
                    onClick={() => navigate(`/projects/${projectId}/agents/${a.id}`)}
                    className="flex min-w-0 items-center gap-3 text-left hover:opacity-80"
                  >
                    <Avatar label={a.name} color={agentColor(a.id)} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">{a.name}</p>
                      <p className="truncate text-xs text-fg-subtle" title={a.model}>
                        {a.lastStatus ?? <span className="mono">{a.model}</span>}
                      </p>
                    </div>
                    <Badge tone="neutral">{ROLE_LABEL[a.role]}</Badge>
                    {isAttached && <Badge tone="neutral">attached</Badge>}
                    {a.status === "running" && <Badge tone="accent">running</Badge>}
                  </button>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <IconButton title="Memory" onClick={() => setMemoryAgent({ id: a.id, name: a.name })}>
                      <BrainCircuit size={15} />
                    </IconButton>
                    <Button variant="secondary" size="sm" onClick={() => newChat.mutate(a.id)} disabled={newChat.isPending}>
                      <MessageSquarePlus size={13} /> New chat
                    </Button>
                    <DeleteButton
                      title={isAttached ? "Remove from this project" : "Delete employee"}
                      onDelete={() => (isAttached ? detachAgent.mutate(a.id) : deleteAgent.mutate(a.id))}
                    />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>

        {showAgentForm && (
          <Card className="mt-3 p-4">
            <h3 className="mb-3 text-sm font-semibold text-fg">New agent</h3>
            <NewAgentForm projectId={projectId!} onCreated={() => setShowAgentForm(false)} />
          </Card>
        )}

        <div className="mb-3 mt-8 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Meetings</h2>
          <button
            onClick={() => setShowMeetingDialog(true)}
            disabled={employees.length < 1}
            className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg disabled:opacity-40"
          >
            <Plus size={13} /> Convene meeting
          </button>
        </div>
        {meetings.length === 0 ? (
          <p className="text-sm text-fg-subtle">
            Convene specific employees into a shared conversation — like pulling them into a call.
          </p>
        ) : (
          <ul className="space-y-2">
            {meetings.map((m) => (
              <li key={m.id}>
                <div
                  onClick={() => navigate(`/projects/${projectId}/meetings/${m.id}`)}
                  className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-bg-raised p-3 hover:bg-bg-hover"
                >
                  <Video size={14} className="flex-shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{m.title}</span>
                  <Badge tone={m.status === "active" ? "accent" : "neutral"}>{m.status}</Badge>
                  <span className="hidden group-hover:block">
                    <DeleteButton title="Delete meeting" onDelete={() => deleteMeeting.mutate(m.id)} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mb-3 mt-8 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Tasks</h2>
          <button
            onClick={() => setShowTaskDialog(true)}
            disabled={employees.length < 1}
            className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg disabled:opacity-40"
          >
            <Plus size={13} /> New task
          </button>
        </div>
        {tasks.length === 0 ? (
          <p className="text-sm text-fg-subtle">
            Create a task and pick exactly which employees should work on it — everyone else stays untouched.
          </p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t) => (
              <li key={t.id}>
                <Card className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <ListTodo size={14} className="mt-0.5 flex-shrink-0 text-accent" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-fg">{t.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-fg-subtle">{t.description}</p>
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <button onClick={() => cycleTaskStatus.mutate({ id: t.id, status: NEXT_TASK_STATUS[t.status] })}>
                        <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABEL[t.status]}</Badge>
                      </button>
                      <DeleteButton title="Delete task" onDelete={() => deleteTask.mutate(t.id)} />
                    </div>
                  </div>
                  {t.assignees.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5 pl-6">
                      {t.assignees.map((a) => (
                        <button
                          key={a.id}
                          disabled={!a.sessionId}
                          onClick={() => a.sessionId && navigate(`/projects/${projectId}/sessions/${a.sessionId}`)}
                          className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50"
                        >
                          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-bg-sunken text-[9px] font-semibold text-fg-muted">
                            {a.agentName.slice(0, 1).toUpperCase()}
                          </span>
                          {a.agentName}
                        </button>
                      ))}
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}

        <div className="mb-3 mt-8 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Routines</h2>
          <button
            onClick={() => setShowRoutineDialog(true)}
            disabled={employees.length < 1}
            className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg disabled:opacity-40"
          >
            <Plus size={13} /> New routine
          </button>
        </div>
        {routineNotice && (
          <p className="mb-3 flex items-center gap-1.5 rounded-md border border-border bg-bg-sunken px-3 py-1.5 text-xs text-fg-muted">
            <Clock size={12} className="text-accent" /> Created routine · {routineNotice}
          </p>
        )}
        {routines.length === 0 ? (
          <p className="text-sm text-fg-subtle">Same brief, on a schedule — daily, weekly, or a custom cron.</p>
        ) : (
          <ul className="space-y-2">
            {routines.map((r) => (
              <li key={r.id}>
                <Card className="flex items-center justify-between p-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Clock size={14} className="flex-shrink-0 text-accent" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">{r.title}</p>
                      <p className="mono truncate text-xs text-fg-subtle">
                        {r.agentName} · {r.schedule}
                      </p>
                    </div>
                    {!r.enabled && <Badge tone="neutral">disabled</Badge>}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => toggleRoutine.mutate({ id: r.id, enabled: !r.enabled })}
                      disabled={toggleRoutine.isPending}
                    >
                      {r.enabled ? "Pause" : "Resume"}
                    </Button>
                    <DeleteButton title="Delete routine" onDelete={() => deleteRoutine.mutate(r.id)} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}

        {teamMessages.length > 0 && (
          <>
            <h2 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Team messages</h2>
            <Card className="max-h-64 space-y-2.5 overflow-y-auto p-3">
              {teamMessages.map((m) => (
                <div key={m.id} className="flex items-start gap-2 text-sm">
                  <span
                    className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: agentColor(m.fromAgentId) }}
                  />
                  <p className="min-w-0 flex-1 leading-snug">
                    <span className="font-medium text-fg" style={{ color: agentColor(m.fromAgentId) }}>
                      {m.fromName}
                    </span>{" "}
                    <span className="text-fg-subtle">→ {m.toName}:</span>{" "}
                    <span className="text-fg-muted">{m.body}</span>
                  </p>
                </div>
              ))}
            </Card>
          </>
        )}

        <NewMeetingDialog
          open={showMeetingDialog}
          onOpenChange={setShowMeetingDialog}
          projectId={projectId!}
          agents={agents}
          onCreated={(meetingId) => navigate(`/projects/${projectId}/meetings/${meetingId}`)}
        />
        <NewTaskDialog open={showTaskDialog} onOpenChange={setShowTaskDialog} projectId={projectId!} agents={agents} />
        <NewRoutineDialog
          open={showRoutineDialog}
          onOpenChange={setShowRoutineDialog}
          projectId={projectId!}
          agents={employees}
          onCreated={(label) => {
            setRoutineNotice(label);
            setTimeout(() => setRoutineNotice(undefined), 6000);
          }}
        />
        <AttachEmployeeDialog
          open={showAttachDialog}
          onOpenChange={setShowAttachDialog}
          projectId={projectId!}
          currentTeamIds={new Set(agents.map((a) => a.id))}
        />
        {memoryAgent && (
          <AgentMemoryDialog
            open={!!memoryAgent}
            onOpenChange={(open) => !open && setMemoryAgent(undefined)}
            agentId={memoryAgent.id}
            agentName={memoryAgent.name}
          />
        )}
      </div>
      {projectId && <FileExplorer projectId={projectId} />}
    </div>
  );
}
