import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BrainCircuit, FolderOpen, Plug, TerminalSquare } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, ProviderConfig } from "../lib/types";
import { ROLE_LABEL } from "../lib/types";
import { agentColor } from "../lib/agent-color";
import { Avatar, Badge, Button, Card, Input, Label, Textarea } from "../components/ui";
import { FileExplorer } from "../components/FileExplorer";
import { ConnectorCatalog } from "../components/ConnectorCatalog";
import { ShellsPanel } from "../components/ShellsPanel";
import { AgentMemoryDialog } from "../components/AgentMemoryDialog";
import { ModelPicker } from "../components/ModelPicker";

type Tab = "overview" | "files" | "mcp" | "shells";

export function EmployeeDetailPage() {
  const { projectId, agentId } = useParams<{ projectId: string; agentId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(searchParams.has("connected") || searchParams.has("oauthError") ? "mcp" : "overview");
  const [showMemory, setShowMemory] = useState(false);

  const { data: agent } = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.get<Agent>(`/agents/${agentId}`),
  });

  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });

  const decideTermination = useMutation({
    mutationFn: (decision: "approved" | "rejected") => api.patch(`/agents/${agentId}/termination`, { decision }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent", agentId] }),
  });

  const [providerConfigId, setProviderConfigId] = useState<string | null>(null);
  const updateModel = useMutation({
    mutationFn: (patch: { providerConfigId?: string; model?: string }) => api.patch(`/agents/${agentId}`, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent", agentId] }),
  });

  if (!agent) return null;
  const effectiveProviderConfigId = providerConfigId ?? agent.providerConfigId;

  const tabs: Array<{ id: Tab; label: string; icon: typeof FolderOpen }> = [
    { id: "overview", label: "Overview", icon: BrainCircuit },
    { id: "files", label: "Personal space", icon: FolderOpen },
    { id: "mcp", label: "Integrations", icon: Plug },
    { id: "shells", label: "Shells", icon: TerminalSquare },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex-shrink-0 border-b border-border px-4 py-4 md:px-6">
        <button
          onClick={() => navigate(`/projects/${projectId}`)}
          className="mb-3 flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
        >
          <ArrowLeft size={12} /> Back to project
        </button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Avatar label={agent.name} color={agentColor(agent.id)} />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold text-fg">{agent.name}</h1>
                <Badge tone={agent.role === "manager" ? "accent" : "neutral"}>{ROLE_LABEL[agent.role]}</Badge>
                {agent.approvalStatus === "pending" && <Badge tone="warning">pending approval</Badge>}
                {agent.approvalStatus === "rejected" && <Badge tone="danger">rejected</Badge>}
                {agent.status === "terminated" && <Badge tone="danger">terminated</Badge>}
                {agent.pendingTermination && <Badge tone="warning">termination pending</Badge>}
              </div>
              <p className="mono mt-0.5 text-xs text-fg-subtle">{agent.model}</p>
            </div>
          </div>

          {agent.pendingTermination && (
            <div className="flex flex-shrink-0 items-center gap-1.5">
              <Button variant="danger" size="sm" onClick={() => decideTermination.mutate("approved")} disabled={decideTermination.isPending}>
                Confirm termination
              </Button>
              <Button variant="ghost" size="sm" onClick={() => decideTermination.mutate("rejected")} disabled={decideTermination.isPending}>
                Keep
              </Button>
            </div>
          )}
        </div>
        {agent.jobDescription && <p className="mt-3 max-w-2xl text-sm text-fg-muted">{agent.jobDescription}</p>}

        <div className="mt-4 flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id ? "bg-bg-hover text-fg" : "text-fg-muted hover:text-fg"
              }`}
            >
              <t.icon size={13} />
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" && (
          <div className="mx-auto max-w-2xl space-y-4 px-6 py-6">
            <Card className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-medium text-fg">Persistent memory</p>
                <p className="text-xs text-fg-subtle">Notes this employee has saved for itself, across every chat and project.</p>
              </div>
              <Button variant="secondary" onClick={() => setShowMemory(true)}>
                <BrainCircuit size={14} /> View
              </Button>
            </Card>

            <Card className="p-4">
              <p className="text-sm font-medium text-fg">Model</p>
              <p className="mb-3 text-xs text-fg-subtle">Change which provider and model this employee runs on.</p>
              <div className="space-y-3">
                <div>
                  <Label>Provider</Label>
                  <select
                    value={effectiveProviderConfigId}
                    onChange={(e) => {
                      setProviderConfigId(e.target.value);
                      updateModel.mutate({ providerConfigId: e.target.value });
                    }}
                    className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
                  >
                    {providers?.providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Model</Label>
                  <ModelPicker
                    providerConfigId={effectiveProviderConfigId}
                    value={agent.model}
                    onChange={(model) => updateModel.mutate({ model })}
                  />
                </div>
                {updateModel.isPending && <p className="text-xs text-fg-subtle">Saving…</p>}
              </div>
            </Card>

            <MascotCard agentId={agent.id} mascot={agent.mascot ?? null} name={agent.name} />

            <ComputerCard agentId={agent.id} backend={agent.computerBackend ?? "local"} />

            <ClearChatCard agentId={agent.id} projectId={projectId!} />

            <ScreenCard agentId={agent.id} />

            <HeartbeatCard agentId={agent.id} minutes={agent.heartbeatMinutes ?? 0} prompt={agent.heartbeatPrompt ?? ""} />

            <SkillsCard agentId={agentId!} />
          </div>
        )}
        {tab === "files" && agentId && projectId && (
          <div className="h-full">
            <FileExplorer projectId={projectId} root="self" agentId={agentId} />
          </div>
        )}
        {tab === "mcp" && agentId && (
          <div className="mx-auto max-w-2xl px-6 py-6">
            <ConnectorCatalog scopeAgentId={agentId} projectId={projectId} />
          </div>
        )}
        {tab === "shells" && agentId && (
          <div className="mx-auto max-w-2xl px-6 py-6">
            <ShellsPanel agentId={agentId} />
          </div>
        )}
      </div>

      {showMemory && (
        <AgentMemoryDialog open={showMemory} onOpenChange={setShowMemory} agentId={agent.id} agentName={agent.name} />
      )}
    </div>
  );
}

type ComputerStatus = { backend: "local" | "docker"; status: string; image: string | null; containerName?: string };

function ComputerCard({ agentId, backend }: { agentId: string; backend: "local" | "docker" }) {
  const queryClient = useQueryClient();
  const [image, setImage] = useState("");
  const { data } = useQuery({
    queryKey: ["computer", agentId],
    queryFn: () => api.get<ComputerStatus>(`/agents/${agentId}/computer`),
    refetchInterval: 10_000,
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/agents/${agentId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["computer", agentId] });
    },
  });
  const restart = useMutation({
    mutationFn: () => api.post(`/agents/${agentId}/computer/restart`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["computer", agentId] }),
  });
  const effectiveBackend = data?.backend ?? backend;

  return (
    <Card className="p-4">
      <p className="text-sm font-medium text-fg">Bot computer</p>
      <p className="mb-3 text-xs text-fg-subtle">
        Docker = an isolated container with its own filesystem, shells, and browser (requires the kuclab-hertz-computer image).
      </p>
      <div className="flex items-center gap-2">
        <select
          value={effectiveBackend}
          onChange={(e) => patch.mutate({ computerBackend: e.target.value })}
          className="h-9 flex-1 rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
        >
          <option value="local">local — on the host machine</option>
          <option value="docker">docker — dedicated container</option>
        </select>
        <Badge tone={effectiveBackend === "docker" ? (data?.status === "running" ? "success" : "warning") : "neutral"}>
          {effectiveBackend === "docker" ? data?.status ?? "?" : "local"}
        </Badge>
      </div>
      {effectiveBackend === "docker" && data?.status === "unavailable" && (
        <p className="mt-2 rounded-md bg-warning-wash p-2 text-xs text-warning">
          Docker isn't accessible to the Hertz service. Re-run the installer (it adds the service user to the docker
          group and restarts the service), then click Restart here.
        </p>
      )}
      {effectiveBackend === "docker" && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="kuclab-hertz-computer:latest" className="h-8 text-xs" />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                patch.mutate({ computerImage: image.trim() || null });
                restart.mutate();
              }}
            >
              Restart
            </Button>
          </div>
          {data?.containerName && <p className="mono truncate text-xs text-fg-subtle">{data.containerName}</p>}
        </div>
      )}
    </Card>
  );
}

function HeartbeatCard({ agentId, minutes, prompt }: { agentId: string; minutes: number; prompt: string }) {
  const queryClient = useQueryClient();
  const [mins, setMins] = useState(String(minutes));
  const [text, setText] = useState(prompt);
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/agents/${agentId}`, {
        heartbeatMinutes: Math.max(0, Number(mins) || 0),
        heartbeatPrompt: text.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  return (
    <Card className="p-4">
      <p className="text-sm font-medium text-fg">Heartbeat</p>
      <p className="mb-3 text-xs text-fg-subtle">
        The agent wakes itself up on an interval, reviews what it owns, and reports only if there is something worth reporting. 0 = off.
      </p>
      <div className="space-y-3">
        <div>
          <Label>Interval (minutes)</Label>
          <Input value={mins} onChange={(e) => setMins(e.target.value)} inputMode="numeric" className="h-8 w-28 text-xs" />
        </div>
        <div>
          <Label>Standing heartbeat instructions</Label>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Check my e-mail and summarize anything urgent. Nothing urgent? Reply just (idle)."
            rows={3}
          />
        </div>
        <Button size="sm" variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </Button>
      </div>
    </Card>
  );
}

interface SkillEntry {
  name: string;
  description: string;
}

function SkillsCard({ agentId }: { agentId: string }) {
  const { data } = useQuery({
    queryKey: ["skills", agentId],
    queryFn: () => api.get<{ skills: SkillEntry[] }>(`/agents/${agentId}/skills`),
    refetchInterval: 15_000,
  });
  const skills = data?.skills ?? [];
  return (
    <Card className="p-4">
      <p className="text-sm font-medium text-fg">Skills</p>
      <p className="mb-2 text-xs text-fg-subtle">
        Procedures the bot learned and saved for reuse (save_skill / read_skill).
      </p>
      {skills.length === 0 ? (
        <p className="text-xs text-fg-subtle">None yet — they appear once the bot saves its first procedure.</p>
      ) : (
        <ul className="space-y-1.5">
          {skills.map((s) => (
            <li key={s.name} className="rounded-md bg-bg-raised px-2.5 py-1.5">
              <span className="mono text-xs text-accent">{s.name}</span>
              <span className="ml-2 text-xs text-fg-muted">{s.description}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}


function ScreenCard({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const { data: status } = useQuery({
    queryKey: ["screen", agentId],
    queryFn: () => api.get<{ running: boolean; tunnelUrl?: string | null }>("/agents/" + agentId + "/screen/status"),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });

  const [error, setError] = useState<string | null>(null);

  async function openViewer() {
    setError(null);
    try {
      const { token } = await api.get<{ token: string }>("/agents/" + agentId + "/screen/token");
      setIframeUrl(`/screen/${agentId}?t=${encodeURIComponent(token)}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function startDesktop() {
    setError(null);
    try {
      await api.post(`/agents/${agentId}/screen/start`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-fg">Screen</p>
        <Badge tone={status?.running ? "success" : "neutral"}>{status?.running ? "live" : "off"}</Badge>
      </div>
      <p className="mb-3 text-xs text-fg-subtle">
        The bot's visible desktop (Xfce) inside its container — watch what it does, take over to log in, or install apps.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => void startDesktop()}>
          Start desktop
        </Button>
        <Button size="sm" variant="primary" onClick={() => { setOpen(true); void openViewer(); }}>
          Open screen
        </Button>
        {status?.running && (
          <Button size="sm" variant="ghost" onClick={() => void startDesktop()}>
            Restart stack
          </Button>
        )}
      </div>
      {error && <p className="mt-2 rounded-md bg-danger-wash p-2 text-xs text-danger">{error}</p>}
      {status?.tunnelUrl && (
        <p className="mt-2 break-all text-xs text-fg-muted">
          Public link:{" "}
          <a className="text-accent underline" href={status.tunnelUrl} target="_blank" rel="noreferrer">
            {status.tunnelUrl}
          </a>{" "}
          <button
            className="ml-1 text-fg-subtle underline"
            onClick={() => {
              void navigator.clipboard?.writeText(status.tunnelUrl!);
            }}
          >
            copy
          </button>
        </p>
      )}
      {open && iframeUrl && (
        <iframe
          title="Agent screen"
          src={iframeUrl}
          className="mt-3 aspect-[16/10] w-full rounded-lg border border-border"
        />
      )}
    </Card>
  );
}


const MASCOT_CHOICES = ["🦊","🐼","🐙","🤖","👾","🦉","🐝","🦖","🐬","🦄","🐸","🐨","🦁","🐷","🐵","🐺","🦋","🐢","🐳","🦜"];

function MascotCard({ agentId, mascot, name }: { agentId: string; mascot: string | null; name: string }) {
  const queryClient = useQueryClient();
  const current = mascot ?? "🤖";
  const pick = useMutation({
    mutationFn: (m: string) => api.patch(`/agents/${agentId}`, { mascot: m }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent", agentId] }),
  });

  return (
    <Card className="p-4">
      <p className="text-sm font-medium text-fg">Mascot</p>
      <p className="mb-3 text-xs text-fg-subtle">{name}'s face everywhere in the app — pick a new one.</p>
      <div className="flex flex-wrap gap-1.5">
        {MASCOT_CHOICES.map((m) => (
          <button
            key={m}
            onClick={() => pick.mutate(m)}
            className={`flex h-10 w-10 items-center justify-center rounded-xl border text-xl transition-all ${
              m === current ? "border-accent bg-accent-wash scale-110" : "border-border hover:bg-bg-hover"
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </Card>
  );
}

function ClearChatCard({ agentId, projectId }: { agentId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const clear = useMutation({
    mutationFn: () => api.post(`/agents/${agentId}/clear-chat`, { projectId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", "all"] });
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });

  return (
    <Card className="p-4">
      <p className="text-sm font-medium text-fg">Chat history</p>
      <p className="mb-3 text-xs text-fg-subtle">
        Deletes this contact's chat messages. Memory and skills are managed separately and stay.
      </p>
      <Button
        size="sm"
        variant="secondary"
        disabled={clear.isPending}
        onClick={() => {
          if (window.confirm("Delete this agent's chat messages? Memory stays.")) clear.mutate();
        }}
      >
        {clear.isPending ? "Clearing…" : "Clear chat"}
      </Button>
      {clear.isSuccess && <p className="mt-2 text-xs text-success">Chat cleared.</p>}
      {clear.isError && <p className="mt-2 text-xs text-danger">{(clear.error as Error).message}</p>}
    </Card>
  );
}
