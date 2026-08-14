import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Agent, HertzSession, Project, ProviderConfig } from "../lib/types";
import { FileExplorer } from "../components/FileExplorer";

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
  });

  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });

  const { data: agentsData } = useQuery({
    queryKey: ["agents", projectId],
    queryFn: () => api.get<{ agents: Agent[] }>(`/projects/${projectId}/agents`),
  });

  const { data: sessionsData } = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.get<{ sessions: HertzSession[] }>(`/projects/${projectId}/sessions`),
    refetchInterval: 5000,
  });

  const [agentName, setAgentName] = useState("agent-1");
  const [providerConfigId, setProviderConfigId] = useState("");
  const [model, setModel] = useState("");

  const createAgent = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/agents", {
        projectId,
        name: agentName,
        providerConfigId,
        model,
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["agents", projectId] });
      setSelectedAgentId(res.id);
    },
  });

  const createSession = useMutation({
    mutationFn: (agentId: string) => api.post<{ id: string }>(`/agents/${agentId}/sessions`),
    onSuccess: (res) => navigate(`/projects/${projectId}/sessions/${res.id}`),
  });

  function onCreateAgent(e: FormEvent) {
    e.preventDefault();
    createAgent.mutate();
  }

  const agents = agentsData?.agents ?? [];
  const sessions = sessionsData?.sessions ?? [];

  return (
    <div className="grid h-full grid-cols-[1fr_320px]">
      <div className="overflow-auto p-6">
        <h1 className="mb-1 text-sm font-semibold">{project?.name}</h1>
        <p className="mb-4 font-mono text-xs text-fg-muted">{project?.roots[0]?.absolutePath}</p>

        <h2 className="mb-2 text-xs font-semibold text-fg-muted">Agents</h2>
        <ul className="mb-4 divide-y divide-border rounded border border-border">
          {agents.map((a) => (
            <li key={a.id} className="flex items-center justify-between px-3 py-2">
              <div>
                <span className="text-sm">{a.name}</span>
                <span className="ml-2 font-mono text-xs text-fg-muted">{a.model}</span>
              </div>
              <button
                onClick={() => createSession.mutate(a.id)}
                disabled={createSession.isPending}
                className="rounded border border-border px-2 py-1 text-xs hover:bg-bg-raised"
              >
                New session
              </button>
            </li>
          ))}
          {agents.length === 0 && <li className="px-3 py-2 text-sm text-fg-muted">No agents yet.</li>}
        </ul>

        <form onSubmit={onCreateAgent} className="mb-6 rounded border border-border bg-bg-raised p-4">
          <h3 className="mb-3 text-xs font-semibold text-fg-muted">New agent</h3>
          <div className="mb-2 flex gap-2">
            <input
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              className="flex-1 rounded border border-border bg-bg px-2 py-1.5 text-sm"
            />
            <select
              value={providerConfigId}
              onChange={(e) => setProviderConfigId(e.target.value)}
              required
              className="rounded border border-border bg-bg px-2 py-1.5 text-sm"
            >
              <option value="">Provider…</option>
              {providers?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              placeholder="model id (see Providers → Scan)"
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="flex-1 rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={createAgent.isPending}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {createAgent.isPending ? "Creating…" : "Create agent"}
          </button>
        </form>

        <h2 className="mb-2 text-xs font-semibold text-fg-muted">Sessions</h2>
        <ul className="divide-y divide-border rounded border border-border">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => navigate(`/projects/${projectId}/sessions/${s.id}`)}
                className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-bg-raised"
              >
                <span className="text-sm">{s.title}</span>
                <span className="text-xs text-fg-muted">{s.status}</span>
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="px-3 py-2 text-sm text-fg-muted">No sessions yet.</li>}
        </ul>
      </div>
      {projectId && <FileExplorer projectId={projectId} />}
    </div>
  );
}
