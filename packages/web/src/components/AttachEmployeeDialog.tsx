import { useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, X } from "lucide-react";
import { api } from "../lib/api";
import type { Agent } from "../lib/types";
import { ROLE_LABEL } from "../lib/types";
import { Avatar, Badge, EmptyState } from "./ui";

export function AttachEmployeeDialog({
  open,
  onOpenChange,
  projectId,
  currentTeamIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  currentTeamIds: Set<string>;
}) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["agents", "all"],
    queryFn: () => api.get<{ agents: Agent[] }>("/agents"),
    enabled: open,
  });

  const attach = useMutation({
    mutationFn: (agentId: string) => api.post(`/projects/${projectId}/agents/${agentId}/attach`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", projectId] }),
  });

  const candidates = useMemo(
    () => (data?.agents ?? []).filter((a) => a.role !== "manager" && !currentTeamIds.has(a.id)),
    [data, currentTeamIds],
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 flex h-[28rem] w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-bg-raised shadow-popover">
          <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-4">
            <Dialog.Title className="text-sm font-semibold text-fg">Add an existing employee</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-fg-muted hover:text-fg">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <p className="border-b border-border px-4 py-2 text-xs text-fg-muted">
            Employees can work across several projects — pick anyone already hired elsewhere to add them here too.
          </p>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {candidates.length === 0 ? (
              <EmptyState
                icon={<UserPlus size={26} strokeWidth={1.5} />}
                title="No one else to add"
                description="Every employee you've hired is already on this project's team."
              />
            ) : (
              <ul className="space-y-1">
                {candidates.map((a) => (
                  <li key={a.id}>
                    <button
                      onClick={() => attach.mutate(a.id)}
                      disabled={attach.isPending}
                      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-bg-hover disabled:opacity-50"
                    >
                      <Avatar label={a.name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-fg">{a.name}</p>
                        <p className="truncate text-xs text-fg-subtle">from {a.homeProjectName}</p>
                      </div>
                      <Badge tone="neutral">{ROLE_LABEL[a.role]}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
