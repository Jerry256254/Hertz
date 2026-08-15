import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, TerminalSquare } from "lucide-react";
import { api } from "../lib/api";
import type { EmployeeShell } from "../lib/types";
import { Badge, Button, Card, EmptyState, Input } from "./ui";
import { DeleteButton } from "./DeleteButton";

function ShellRow({ shell }: { shell: EmployeeShell }) {
  const queryClient = useQueryClient();
  const [buffer, setBuffer] = useState<string | undefined>(undefined);
  const [loadingBuffer, setLoadingBuffer] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.delete(`/shells/${shell.id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["shells"] }),
  });

  async function loadBuffer() {
    if (buffer !== undefined) {
      setBuffer(undefined);
      return;
    }
    setLoadingBuffer(true);
    const res = await api.get<{ buffer: string; alive: boolean }>(`/shells/${shell.id}/buffer`);
    setBuffer(res.buffer || "(nothing yet)");
    setLoadingBuffer(false);
  }

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-3">
        <button onClick={loadBuffer} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" disabled={loadingBuffer}>
          <TerminalSquare size={14} className="flex-shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{shell.name}</p>
            <p className="truncate text-xs text-fg-subtle">
              {shell.owned ? "yours" : `shared by ${shell.ownerName}`}
              {shell.sharedWith.length > 0 && ` · shared with ${shell.sharedWith.join(", ")}`}
            </p>
          </div>
          <Badge tone={shell.alive ? "accent" : "neutral"}>{shell.alive ? "live" : "not running"}</Badge>
        </button>
        {shell.owned && <DeleteButton title="Close shell" onDelete={() => remove.mutate()} />}
      </div>
      {buffer !== undefined && (
        <pre className="mono mt-2.5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-sunken p-2 text-[11px] leading-relaxed text-fg-muted">
          {buffer}
        </pre>
      )}
    </Card>
  );
}

/** Shows every persistent shell an employee owns or has been given access to — real transcripts, so the user can see exactly what ran. */
export function ShellsPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");

  const { data } = useQuery({
    queryKey: ["shells", agentId],
    queryFn: () => api.get<{ shells: EmployeeShell[] }>(`/agents/${agentId}/shells`),
  });

  const create = useMutation({
    mutationFn: () => api.post(`/agents/${agentId}/shells`, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["shells", agentId] });
      setName("");
      setShowForm(false);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate();
  }

  const shells = data?.shells ?? [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Shells</h2>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
          <Plus size={13} /> New shell
        </button>
      </div>

      {showForm && (
        <form onSubmit={onSubmit} className="mb-3 flex gap-1.5">
          <Input placeholder="Shell name, e.g. main" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Button type="submit" variant="primary" disabled={create.isPending || !name.trim()}>
            Open
          </Button>
        </form>
      )}

      {shells.length === 0 ? (
        <EmptyState
          icon={<TerminalSquare size={26} strokeWidth={1.5} />}
          title="No shells yet"
          description="A real, persistent Linux shell — cwd and env vars survive between commands, unlike the sandboxed shell tool."
        />
      ) : (
        <div className="space-y-2">
          {shells.map((s) => (
            <ShellRow key={s.id} shell={s} />
          ))}
        </div>
      )}
    </div>
  );
}
