import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, Bot, ChevronDown, Clock, FolderGit2, ListTodo, MessageSquarePlus, Plus, UserPlus, Users, Video } from "lucide-react";
import { api } from "../lib/api";
import type {
  Agent,
  AgentRole,
  ConversationSummary,
  HertzTask,
  Meeting,
  Project,
  ProviderConfig,
  Routine,
} from "../lib/types";
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
  const { user } = useAuth();
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [showManagerForm, setShowManagerForm] = useState(false);
  const [showMeetingDialog, setShowMeetingDialog] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
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

  const { data: conversationsData } = useQuery({
    queryKey: ["conversations", projectId],
    queryFn: () => api.get<{ conversations: ConversationSummary[] }>(`/projects/${projectId}/conversations`),
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
  const pendingTerminations = agents.filter((a) => a.pendingTermination);

  const decideTermination = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "rejected" }) =>
      api.patch(`/agents/${id}/termination`, { decision }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", projectId] }),
  });

  const toggleAutoApprove = useMutation({
    mutationFn: (autoApprove: boolean) => api.patch(`/projects/${projectId}/auto-approve`, { autoApprove }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
  });

  const meetings = meetingsData?.meetings ?? [];
  const tasks = tasksData?.tasks ?? [];
  const routines = routinesData?.routines ?? [];
  const conversations = conversationsData?.conversations ?? [];

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
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1 md:grid-cols-[1fr_320px]">
      <div className="overflow-auto px-4 py-6 md:px-6">
        <div className="mb-6 flex items-center gap-2">
          <FolderGit2 size={18} className="text-accent" />
          <div>
            <h1 className="text-base font-semibold leading-tight text-fg">{project?.name}</h1>
            <p className="mono text-xs leading-tight text-fg-subtle">{project?.roots[0]?.absolutePath}</p>
          </div>
        </div>

        {user?.role === "admin" && projectId && <ProjectAccessSection projectId={projectId} />}

        {project && (
          <Card className="mb-6 flex items-center justify-between p-3">
            <div>
              <p className="text-sm font-medium text-fg">Auto-approve manager requests</p>
              <p className="text-xs text-fg-subtle">
                When on, the manager's hires and firings take effect immediately instead of waiting for your approval.
              </p>
            </div>
            <Button
              variant={project.autoApprove ? "primary" : "secondary"}
              size="sm"
              onClick={() => toggleAutoApprove.mutate(!project.autoApprove)}
              disabled={toggleAutoApprove.isPending}
            >
              {project.autoApprove ? "On" : "Off"}
            </Button>
          </Card>
        )}

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

        {pendingTerminations.length > 0 && (
          <div className="mb-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Pending termination · {pendingTerminations.length}
            </h2>
            <ul className="space-y-2">
              {pendingTerminations.map((a) => (
                <li key={a.id}>
                  <Card className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <Avatar label={a.name} color={agentColor(a.id)} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-fg">
                            {a.name} <span className="font-normal text-fg-subtle">· {ROLE_LABEL[a.role]}</span>
                          </p>
                          <p className="mt-0.5 text-xs text-fg-muted">The manager requested to let this employee go.</p>
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => decideTermination.mutate({ id: a.id, decision: "approved" })}
                          disabled={decideTermination.isPending}
                        >
                          Confirm termination
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => decideTermination.mutate({ id: a.id, decision: "rejected" })}
                          disabled={decideTermination.isPending}
                        >
                          Keep
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
              onClick={() => setShowGroupDialog(true)}
              disabled={agents.length < 1}
              className="flex items-center gap-1 text-xs text-accent hover:text-fg disabled:opacity-40"
            >
              <Users size={13} /> New group chat
            </button>
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
                <TaskCard projectId={projectId!} task={t} onDelete={() => deleteTask.mutate(t.id)} onCycleStatus={() => cycleTaskStatus.mutate({ id: t.id, status: NEXT_TASK_STATUS[t.status] })} />
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

        {conversations.length > 0 && (
          <>
            <h2 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Direct messages
            </h2>
            <Card className="max-h-64 space-y-1 overflow-y-auto p-2">
              {conversations.map((c) => (
                <Link
                  key={c.id}
                  to={`/projects/${projectId}/sessions/${c.id}`}
                  className="flex items-start gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-bg-hover"
                >
                  <span
                    className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: agentColor(c.peerAgentId) }}
                  />
                  <p className="min-w-0 flex-1 leading-snug">
                    <span className="font-medium text-fg" style={{ color: agentColor(c.peerAgentId) }}>
                      {c.peerAgentName ?? c.title}
                    </span>{" "}
                    <span className="text-fg-muted">{c.lastMessagePreview}</span>
                  </p>
                </Link>
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
        <NewGroupChatDialog open={showGroupDialog} onOpenChange={setShowGroupDialog} projectId={projectId!} agents={agents} />
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
      {projectId && (
        <div className="hidden md:block">
          <FileExplorer projectId={projectId} />
        </div>
      )}
    </div>
  );
}

function TaskCard({
  projectId,
  task,
  onCycleStatus,
  onDelete,
}: {
  projectId: string;
  task: HertzTask;
  onCycleStatus: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const { data: detail } = useQuery({
    queryKey: ["task", task.id],
    queryFn: () => api.get<HertzTask>(`/tasks/${task.id}`),
    enabled: expanded,
  });
  const d = detail ?? task;

  return (
    <Card className="p-3">
      <div
        className="flex cursor-pointer items-start justify-between gap-3"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <ListTodo size={14} className="mt-0.5 flex-shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{task.title}</p>
            {!expanded && <p className="mt-0.5 line-clamp-2 text-xs text-fg-subtle">{task.description}</p>}
            {expanded && <p className="text-xs text-fg-subtle">{new Date(task.createdAt).toLocaleString()}</p>}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button onClick={onCycleStatus}>
            <Badge tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Badge>
          </button>
          <DeleteButton title="Delete task" onDelete={onDelete} />
          <ChevronDown size={14} className={`text-fg-subtle transition-transform ${expanded ? "rotate-180" : ""}`} />
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3 pl-6">
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Brief</p>
            <pre className="whitespace-pre-wrap rounded-md bg-bg-sunken p-3 text-xs text-fg-muted">{d.description}</pre>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Timeline</p>
            <p className="text-xs text-fg-subtle">
              Started {new Date(d.createdAt).toLocaleString()} · updated {new Date(d.updatedAt).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Assignees & live work log</p>
            {d.assignees.length === 0 ? (
              <p className="text-xs text-fg-subtle">No assignees.</p>
            ) : (
              <ul className="space-y-2.5">
                {d.assignees.map((a) => (
                  <li key={a.id} className="rounded-md border border-border px-2.5 py-2">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2 text-xs text-fg">
                        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-bg-sunken text-[10px] font-semibold text-fg-muted">
                          {a.agentName.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="truncate">{a.agentName}</span>
                        <span className="flex-shrink-0 text-fg-subtle">· {a.agentRole}</span>
                      </span>
                      <span className="flex flex-shrink-0 items-center gap-1.5">
                        {a.sessionId && (
                          <>
                            <SessionActions sessionId={a.sessionId} />
                            <Button size="sm" variant="secondary" onClick={() => navigate(`/projects/${projectId}/sessions/${a.sessionId}`)}>
                              Open chat
                            </Button>
                          </>
                        )}
                      </span>
                    </div>
                    {a.sessionId ? (
                      <SessionActivity sessionId={a.sessionId} />
                    ) : (
                      <p className="text-xs text-fg-subtle">Not started yet.</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

interface SessionSnapshot {
  session: { status: string; createdAt: string; updatedAt: string };
  running: boolean;
  messages: Array<{ id: string; role: string; senderAgentId: string | null; content: Array<{ type: string; text?: string; name?: string }> }>;
}

/** Live step log for one assignee's work session: tool calls/results + latest text, polled while expanded. */
function SessionActivity({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({
    queryKey: ["task-session", sessionId],
    queryFn: () => api.get<SessionSnapshot>(`/sessions/${sessionId}`),
    refetchInterval: 4000,
  });
  if (!data) return <p className="text-xs text-fg-subtle">Loading activity…</p>;

  const events: string[] = [];
  for (const m of [...data.messages].reverse()) {
    for (const b of m.content ?? []) {
      if (b.type === "tool_use" && b.name) events.push(`→ ${b.name}`);
      else if (b.type === "tool_result") events.push(`   ${(b as unknown as { content?: string }).content?.slice(0, 90) ?? ""}`);
      else if (b.type === "text" && m.role === "assistant" && b.text) events.push(`✓ ${b.text.replace(/\s+/g, " ").slice(0, 110)}`);
    }
    if (events.length >= 14) break;
  }

  return (
    <div>
      <p className="mb-1 text-[11px] text-fg-subtle">
        status: <span className="text-fg">{data.running ? "running" : data.session.status}</span> · started{" "}
        {new Date(data.session.createdAt).toLocaleTimeString()} · last activity {new Date(data.session.updatedAt).toLocaleTimeString()}
      </p>
      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-bg-sunken p-2 text-[11px] leading-relaxed text-fg-muted">
{events.length > 0 ? events.join("\n") : "(no steps yet)"}
      </pre>
    </div>
  );
}

function SessionActions({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: ({ action }: { action: string }) => api.post(`/sessions/${sessionId}/${action}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task-session", sessionId] });
    },
  });
  return (
    <>
      <IconButton title="Pause this agent" onClick={() => act.mutate({ action: "pause" })}>
        ⏸
      </IconButton>
      <IconButton title="Stop the current run" onClick={() => act.mutate({ action: "stop" })}>
        ■
      </IconButton>
      <IconButton
        title="Nudge to continue working"
        onClick={() =>
          api.post(`/sessions/${sessionId}/messages`, { text: "[Continue working on your assigned task until it is fully done.]" })
        }
      >
        ▶
      </IconButton>
    </>
  );
}

function NewGroupChatDialog({
  open,
  onOpenChange,
  projectId,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  agents: Agent[];
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/projects/${projectId}/group-chats`, { title: title.trim() || "Group chat", agentIds: [...selected] }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onOpenChange(false);
      setTitle("");
      setSelected(new Set());
      navigate(`/projects/${projectId}/sessions/${created.id}`);
    },
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-raised p-5 shadow-popover">
          <Dialog.Title className="mb-1 text-sm font-semibold text-fg">New group chat</Dialog.Title>
          <Dialog.Description className="mb-4 text-xs text-fg-subtle">
            Pick the bots that should share one messenger-style thread — they answer together, @mention to address one.
          </Dialog.Description>

          <Label>Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Launch crew" />

          <p className="mb-2 mt-4 text-xs font-medium text-fg-muted">Participants ({selected.size})</p>
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {agents.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => toggle(a.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected.has(a.id) ? "border-accent bg-accent-wash" : "border-border hover:bg-bg-hover"
                  }`}
                >
                  <Avatar label={a.name} color={agentColor(a.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{a.name}</span>
                    <span className="block truncate text-xs text-fg-subtle">{ROLE_LABEL[a.role]}</span>
                  </span>
                  {selected.has(a.id) && <Badge tone="accent">in</Badge>}
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={selected.size === 0 || create.isPending} onClick={() => create.mutate()}>
              Create group chat
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
