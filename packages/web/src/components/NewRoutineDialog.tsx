import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "../lib/api";
import type { Agent } from "../lib/types";
import { ROLE_LABEL } from "../lib/types";
import { Button, Input, Label, Textarea } from "./ui";

const FREQUENCY_LABEL: Record<string, string> = {
  once: "Once",
  daily: "Every day",
  weekly: "Every week",
};

export function NewRoutineDialog({
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
  onCreated: (frequencyLabel: string) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [taskTemplate, setTaskTemplate] = useState("");
  const [agentId, setAgentId] = useState("");
  const [frequency, setFrequency] = useState<"once" | "daily" | "weekly" | "custom">("weekly");
  const [customCron, setCustomCron] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const create = useMutation({
    mutationFn: () =>
      api.post(`/projects/${projectId}/routines`, {
        agentId,
        title,
        taskTemplate,
        schedule: frequency === "custom" ? customCron : frequency,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["routines", projectId] });
      const label = frequency === "custom" ? `cron ${customCron}` : FREQUENCY_LABEL[frequency];
      setTitle("");
      setTaskTemplate("");
      setAgentId("");
      onOpenChange(false);
      onCreated(label ?? frequency);
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    create.mutate();
  }

  const canCreate = title.trim() && taskTemplate.trim() && agentId && (frequency !== "custom" || customCron.trim());

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-raised shadow-popover">
          <div className="flex h-12 items-center justify-between border-b border-border px-4">
            <Dialog.Title className="text-sm font-semibold text-fg">New routine</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-fg-muted hover:text-fg">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <form onSubmit={onSubmit} className="space-y-3 p-4">
            <div>
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly inbox triage" required />
            </div>
            <div>
              <Label>Brief — sent fresh every time it runs</Label>
              <Textarea value={taskTemplate} onChange={(e) => setTaskTemplate(e.target.value)} rows={3} required />
            </div>
            <div>
              <Label>Who runs it</Label>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                required
                className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
              >
                <option value="">Select an employee…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {ROLE_LABEL[a.role]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Repeat</Label>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as typeof frequency)}
                className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
              >
                <option value="once">Once</option>
                <option value="daily">Every day, same time</option>
                <option value="weekly">Every week, same day &amp; time</option>
                <option value="custom">Custom cron expression</option>
              </select>
            </div>
            {frequency === "custom" && (
              <div>
                <Label>Cron expression</Label>
                <Input
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 3 * * 1"
                  className="mono"
                  required
                />
              </div>
            )}
            {error && <p className="text-xs text-danger">{error}</p>}
            <Button type="submit" variant="primary" className="w-full" disabled={!canCreate || create.isPending}>
              {create.isPending ? "Creating…" : "Create routine"}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
