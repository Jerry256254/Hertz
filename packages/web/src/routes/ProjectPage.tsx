import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, FolderGit2, MessageSquarePlus, Plus, Search } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, ModelInfo, Project, ProviderConfig } from "../lib/types";
import { FileExplorer } from "../components/FileExplorer";
import { Avatar, Badge, Button, Card, EmptyState, Input, Label } from "../components/ui";

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

function NewAgentForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const queryClient = useQueryClient();
  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });
  const [name, setName] = useState("agent-1");
  const [providerConfigId, setProviderConfigId] = useState("");
  const [model, setModel] = useState("");

  const createAgent = useMutation({
    mutationFn: () => api.post<{ id: string }>("/agents", { projectId, name, providerConfigId, model }),
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
        {createAgent.isPending ? "Creating…" : "Create agent"}
      </Button>
    </form>
  );
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [showAgentForm, setShowAgentForm] = useState(false);

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
  });

  const { data: agentsData } = useQuery({
    queryKey: ["agents", projectId],
    queryFn: () => api.get<{ agents: Agent[] }>(`/projects/${projectId}/agents`),
  });

  const newChat = useMutation({
    mutationFn: (agentId: string) => api.post<{ id: string }>(`/agents/${agentId}/sessions`),
    onSuccess: (res) => navigate(`/projects/${projectId}/sessions/${res.id}`),
  });

  const agents = agentsData?.agents ?? [];

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

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Agents</h2>
          <button
            onClick={() => setShowAgentForm((v) => !v)}
            className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
          >
            <Plus size={13} /> New agent
          </button>
        </div>

        {agents.length === 0 && !showAgentForm && (
          <Card>
            <EmptyState
              icon={<Bot size={26} strokeWidth={1.5} />}
              title="No agents yet"
              description="An agent pairs a model with this project. Create one to start chatting."
              action={
                <Button variant="primary" onClick={() => setShowAgentForm(true)}>
                  <Plus size={14} /> New agent
                </Button>
              }
            />
          </Card>
        )}

        <ul className="space-y-2">
          {agents.map((a) => (
            <li key={a.id}>
              <Card className="flex items-center justify-between p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar label={a.name} tone="accent" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{a.name}</p>
                    <p className="mono truncate text-xs text-fg-subtle">{a.model}</p>
                  </div>
                  <Badge tone={a.status === "running" ? "accent" : "neutral"}>{a.status}</Badge>
                </div>
                <Button variant="secondary" size="sm" onClick={() => newChat.mutate(a.id)} disabled={newChat.isPending}>
                  <MessageSquarePlus size={13} /> New chat
                </Button>
              </Card>
            </li>
          ))}
        </ul>

        {showAgentForm && (
          <Card className="mt-3 p-4">
            <h3 className="mb-3 text-sm font-semibold text-fg">New agent</h3>
            <NewAgentForm projectId={projectId!} onCreated={() => setShowAgentForm(false)} />
          </Card>
        )}
      </div>
      {projectId && <FileExplorer projectId={projectId} />}
    </div>
  );
}