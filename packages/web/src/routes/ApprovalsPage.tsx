import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, EmptyState } from "../components/ui";

export interface ApprovalItem {
  id: string;
  projectId: string;
  sessionId: string;
  summary: string;
  detail: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  agentName: string;
  projectName: string;
  sessionTitle: string;
}

function fmtDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function ApprovalsPage() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: ApprovalItem[] }>("/approvals"),
    refetchInterval: 5000,
  });

  const decide = useMutation({
    mutationFn: (args: { id: string; decision: "approved" | "rejected" }) =>
      api.post(`/approvals/${args.id}/decision`, { decision: args.decision }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const approvals = data?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending").slice(0, 30);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <div className="mb-5 flex items-center gap-2">
        <ShieldCheck size={18} className="text-accent" />
        <h1 className="text-base font-semibold text-fg">Schválení</h1>
      </div>
      <p className="mb-6 text-sm text-fg-muted">
        Akce, u kterých se agenti předem ptají ("Mám to poslat?"). Rozhodnutí se hned vrátí agentovi do práce.
      </p>

      {pending.length === 0 ? (
        <EmptyState title="Nic nečeká" description="Když bude některý bot potřebovat souhlas s citlivou akcí, objeví se tu." />
      ) : (
        <div className="mb-8 space-y-3">
          {pending.map((a) => (
            <Card key={a.id}>
              <CardHeader>
                <CardTitle className="text-sm">{a.summary}</CardTitle>
                <CardDescription>
                  {a.agentName} · {a.projectName} · {fmtDate(a.createdAt)}
                </CardDescription>
              </CardHeader>
              {a.detail && (
                <pre className="mx-4 mb-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-bg-raised p-3 text-xs text-fg-muted">
                  {a.detail}
                </pre>
              )}
              <div className="flex gap-2 px-4 pb-4">
                <Button
                  size="sm"
                  onClick={() => decide.mutate({ id: a.id, decision: "approved" })}
                  disabled={decide.isPending}
                >
                  Schválit
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => decide.mutate({ id: a.id, decision: "rejected" })}
                  disabled={decide.isPending}
                >
                  Zamítnout
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <>
          <h2 className="mb-3 text-sm font-medium text-fg">Historie</h2>
          <ul className="space-y-1.5">
            {decided.map((a) => (
              <li key={a.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
                <Badge tone={a.status === "approved" ? "success" : "danger"}>
                  {a.status === "approved" ? "schváleno" : "zamítnuto"}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-fg">{a.summary}</span>
                <span className="flex-shrink-0 text-fg-subtle">{a.agentName}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
