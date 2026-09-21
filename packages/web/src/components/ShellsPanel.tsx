import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, TerminalSquare } from "lucide-react";
import { api } from "../lib/api";
import type { EmployeeShell } from "../lib/types";
import { Badge, Button, Card, EmptyState, Input } from "./ui";
import { Trash2 } from "lucide-react";

function ShellRow({ shell }: { shell: EmployeeShell }) {
  const queryClient = useQueryClient();
  const [buffer, setBuffer] = useState<string | undefined>(undefined);
  const [loadingBuffer, setLoadingBuffer] = useState(false);
  const [bufferError, setBufferError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => api.delete(`/shells/${shell.id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["shells"] }),
  });

  async function loadBuffer() {
    if (buffer !== undefined) {
      setBuffer(undefined);
      setBufferError(null);
      return;
    }
    setLoadingBuffer(true);
    setBufferError(null);
    try {
      const res = await api.get<{ buffer: string; alive: boolean }>(`/shells/${shell.id}/buffer`);
      setBuffer(res.buffer || "(zatím prázdný)");
    } catch {
      setBufferError("Výpis se nepodařilo načíst.");
    } finally {
      setLoadingBuffer(false);
    }
  }

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-3">
        <button onClick={loadBuffer} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" disabled={loadingBuffer}>
          <TerminalSquare size={14} className="flex-shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{shell.name}</p>
            <p className="truncate text-xs text-fg-subtle">
              {shell.owned ? "tvůj" : `sdíleno od ${shell.ownerName}`}
              {shell.sharedWith.length > 0 && ` · sdíleno s ${shell.sharedWith.join(", ")}`}
            </p>
          </div>
          <Badge tone={shell.alive ? "accent" : "neutral"}>{shell.alive ? "běží" : "zastavený"}</Badge>
        </button>
        {shell.owned && (
          <button
            title="Zavřít terminál"
            onClick={() => { if (window.confirm(`Zavřít terminál „${shell.name}“?`)) remove.mutate(); }}
            className="rounded-full p-2 text-fg-subtle hover:bg-bg-sunken hover:text-danger"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {bufferError && (
        <p className="mt-2 text-[12px] text-danger">
          {bufferError}{" "}
          <button onClick={loadBuffer} className="font-[600] hover:underline">
            Zkusit znovu
          </button>
        </p>
      )}
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
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Terminály</h2>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
          <Plus size={13} /> Nový terminál
        </button>
      </div>

      {showForm && (
        <form onSubmit={onSubmit} className="mb-3 flex gap-1.5">
          <Input placeholder="Název terminálu, např. main" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Button type="submit" variant="primary" disabled={create.isPending || !name.trim()}>
            Vytvořit
          </Button>
        </form>
      )}
      {showForm && create.isError && (
        <p className="mb-3 text-[12px] text-danger">Terminál se nepodařilo vytvořit.</p>
      )}

      {shells.length === 0 ? (
        <EmptyState
          icon={<TerminalSquare size={26} strokeWidth={1.5} />}
          title="Zatím žádný terminál"
          description="Opravdový, trvalý Linux terminál — pracovní adresář a proměnné prostředí přežijí mezi příkazy, na rozdíl od sandboxovaného shell nástroje."
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
