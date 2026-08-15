import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, Plug, X } from "lucide-react";
import { api } from "../lib/api";
import type { AgentMemoryNote, McpToolsForAgent } from "../lib/types";
import { Avatar, Badge, EmptyState } from "./ui";
import { DeleteButton } from "./DeleteButton";

export function AgentMemoryDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
}) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["agent-memory", agentId],
    queryFn: () => api.get<{ notes: AgentMemoryNote[] }>(`/agents/${agentId}/memory`),
    enabled: open,
  });

  const deleteNote = useMutation({
    mutationFn: (noteId: string) => api.delete(`/agents/${agentId}/memory/${noteId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent-memory", agentId] }),
  });

  const { data: mcpData } = useQuery({
    queryKey: ["agent-mcp-tools", agentId],
    queryFn: () => api.get<{ servers: McpToolsForAgent[] }>(`/agents/${agentId}/mcp-tools`),
    enabled: open,
  });

  const notes = data?.notes ?? [];
  const mcpServers = mcpData?.servers ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 flex h-[28rem] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-bg-raised shadow-popover">
          <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <Avatar label={agentName} tone="accent" />
              <div>
                <Dialog.Title className="text-sm font-semibold leading-none text-fg">{agentName}'s memory</Dialog.Title>
                <p className="mt-0.5 text-[11px] leading-none text-fg-subtle">Persists across every chat &amp; project</p>
              </div>
            </div>
            <Dialog.Close asChild>
              <button className="text-fg-muted hover:text-fg">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {notes.length === 0 ? (
              <EmptyState
                icon={<BrainCircuit size={26} strokeWidth={1.5} />}
                title="Nothing remembered yet"
                description="This agent hasn't written anything to its own memory yet — it will, over time, using the remember tool."
              />
            ) : (
              <ul className="space-y-1.5">
                {notes.map((note) => (
                  <li
                    key={note.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-fg">{note.note}</p>
                    <DeleteButton title="Forget this" onDelete={() => deleteNote.mutate(note.id)} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {mcpServers.length > 0 && (
            <div className="flex-shrink-0 border-t border-border p-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
                <Plug size={12} /> MCP tools available
              </p>
              <div className="flex flex-wrap gap-1.5">
                {mcpServers.map((s) =>
                  s.error ? (
                    <Badge key={s.serverId} tone="danger">
                      {s.serverName}: unreachable
                    </Badge>
                  ) : (
                    s.tools.map((t) => (
                      <Badge key={`${s.serverId}-${t}`} tone="neutral" className="mono">
                        {s.serverName}.{t}
                      </Badge>
                    ))
                  ),
                )}
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
