import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { Avatar, Badge, Button, Card } from "./ui";
import { DeleteButton } from "./DeleteButton";

interface Member {
  id: string;
  userId: string;
  email: string;
  role: "admin" | "user";
}

interface ManagedUser {
  id: string;
  email: string;
  role: "admin" | "user";
}

/** Admin-only: who besides other admins (who always see everything) can see this project. */
export function ProjectAccessSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");

  const { data: membersData } = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => api.get<{ members: Member[] }>(`/projects/${projectId}/members`),
    enabled: open,
  });

  const { data: usersData } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<{ users: ManagedUser[] }>("/users"),
    enabled: open,
  });

  const grant = useMutation({
    mutationFn: (userId: string) => api.post(`/projects/${projectId}/members`, { userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
      setSelected("");
    },
  });

  const revoke = useMutation({
    mutationFn: (userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["project-members", projectId] }),
  });

  const members = membersData?.members ?? [];
  const grantable = (usersData?.users ?? []).filter((u) => u.role !== "admin" && !members.some((m) => m.userId === u.id));

  return (
    <div className="mb-6">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        <ShieldCheck size={13} /> Access — who can see this project
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-fg-subtle">Admins always see every project. Grant a user account access here.</p>
          {members.map((m) => (
            <Card key={m.id} className="flex items-center justify-between p-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Avatar label={m.email} />
                <span className="truncate text-sm text-fg">{m.email}</span>
                <Badge tone="neutral">{m.role}</Badge>
              </div>
              <DeleteButton title="Revoke access" onDelete={() => revoke.mutate(m.userId)} />
            </Card>
          ))}
          {members.length === 0 && <p className="text-xs text-fg-subtle">No user accounts granted yet — only admins can see this project.</p>}
          {grantable.length > 0 && (
            <div className="flex gap-1.5">
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="h-8 flex-1 rounded-md border border-border bg-bg-raised px-2 text-xs text-fg outline-none focus:border-accent"
              >
                <option value="">Grant access to…</option>
                {grantable.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.email}
                  </option>
                ))}
              </select>
              <Button variant="secondary" size="sm" onClick={() => selected && grant.mutate(selected)} disabled={!selected || grant.isPending}>
                Grant
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
