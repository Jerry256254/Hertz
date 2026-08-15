import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BrainCircuit, FolderOpen, Plug, TerminalSquare } from "lucide-react";
import { api } from "../lib/api";
import type { Agent } from "../lib/types";
import { ROLE_LABEL } from "../lib/types";
import { agentColor } from "../lib/agent-color";
import { Avatar, Badge, Button, Card } from "../components/ui";
import { FileExplorer } from "../components/FileExplorer";
import { ConnectorCatalog } from "../components/ConnectorCatalog";
import { ShellsPanel } from "../components/ShellsPanel";
import { AgentMemoryDialog } from "../components/AgentMemoryDialog";

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

  const decideHire = useMutation({
    mutationFn: (approvalStatus: "approved" | "rejected") => api.patch(`/agents/${agentId}/approval`, { approvalStatus }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent", agentId] }),
  });

  if (!agent) return null;

  const tabs: Array<{ id: Tab; label: string; icon: typeof FolderOpen }> = [
    { id: "overview", label: "Overview", icon: BrainCircuit },
    { id: "files", label: "Personal space", icon: FolderOpen },
    { id: "mcp", label: "Integrations", icon: Plug },
    { id: "shells", label: "Shells", icon: TerminalSquare },
  ];

  return (
    <div className="flex h-full flex-col">
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
              </div>
              <p className="mono mt-0.5 text-xs text-fg-subtle">{agent.model}</p>
            </div>
          </div>
          {agent.approvalStatus === "pending" && (
            <div className="flex flex-shrink-0 items-center gap-1.5">
              <Button variant="primary" size="sm" onClick={() => decideHire.mutate("approved")} disabled={decideHire.isPending}>
                Approve
              </Button>
              <Button variant="ghost" size="sm" onClick={() => decideHire.mutate("rejected")} disabled={decideHire.isPending}>
                Reject
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
          <div className="mx-auto max-w-2xl px-6 py-6">
            <Card className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-medium text-fg">Persistent memory</p>
                <p className="text-xs text-fg-subtle">Notes this employee has saved for itself, across every chat and project.</p>
              </div>
              <Button variant="secondary" onClick={() => setShowMemory(true)}>
                <BrainCircuit size={14} /> View
              </Button>
            </Card>
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
