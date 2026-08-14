import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { api } from "../lib/api";
import type { Agent } from "../lib/types";
import { ROLE_LABEL } from "../lib/types";
import { Avatar, Button, Input, Label } from "./ui";

export function NewMeetingDialog({
  open,
  onOpenChange,
  projectId,
  agents,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  agents: Agent[];
  onCreated: (meetingId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const createMeeting = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/projects/${projectId}/meetings`, {
        title: title || "Meeting",
        participantAgentIds: [...selected],
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["meetings", projectId] });
      setTitle("");
      setSelected(new Set());
      onCreated(res.id);
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
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-raised shadow-popover">
          <div className="flex h-12 items-center justify-between border-b border-border px-4">
            <Dialog.Title className="text-sm font-semibold text-fg">Convene a meeting</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-fg-muted hover:text-fg">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="p-4">
            <Label>Title</Label>
            <Input
              placeholder="What's this about?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mb-4"
            />

            <Label>Who's joining</Label>
            <div className="mb-4 max-h-64 overflow-y-auto rounded-md border border-border">
              {agents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => toggle(a.id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-bg-hover"
                >
                  <Avatar label={a.name} tone={a.role === "manager" ? "accent" : "neutral"} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg">{a.name}</p>
                    <p className="text-xs text-fg-subtle">{ROLE_LABEL[a.role]}</p>
                  </div>
                  {selected.has(a.id) && <Check size={14} className="flex-shrink-0 text-accent" />}
                </button>
              ))}
              {agents.length === 0 && <p className="p-3 text-xs text-fg-subtle">No agents on this project yet.</p>}
            </div>

            <Button
              variant="primary"
              className="w-full"
              disabled={selected.size === 0 || createMeeting.isPending}
              onClick={() => createMeeting.mutate()}
            >
              {createMeeting.isPending ? "Creating…" : `Start meeting${selected.size ? ` (${selected.size})` : ""}`}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
