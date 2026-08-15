import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users as UsersIcon, Plus } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Avatar, Badge, Button, Card, Input, Label } from "../components/ui";
import { DeleteButton } from "../components/DeleteButton";

interface ManagedUser {
  id: string;
  email: string;
  role: "admin" | "user";
  createdAt: string;
}

function NewUserForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [error, setError] = useState<string | undefined>(undefined);

  const create = useMutation({
    mutationFn: () => api.post("/users", { email, password, role }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      onDone();
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    create.mutate();
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <Label>Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <Label>Password</Label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        </div>
        <div>
          <Label>Role</Label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "user")}
            className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="user">User — only sees projects granted to them</option>
            <option value="admin">Admin — sees and manages everything</option>
          </select>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create account"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function UserRow({ managedUser, isSelf }: { managedUser: ManagedUser; isSelf: boolean }) {
  const queryClient = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const toggleRole = useMutation({
    mutationFn: () => api.patch(`/users/${managedUser.id}/role`, { role: managedUser.role === "admin" ? "user" : "admin" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["users"] }),
  });

  const resetPassword = useMutation({
    mutationFn: () => api.patch(`/users/${managedUser.id}/password`, { newPassword }),
    onSuccess: () => {
      setNewPassword("");
      setResetting(false);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/users/${managedUser.id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["users"] }),
  });

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar label={managedUser.email} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">
              {managedUser.email} {isSelf && <span className="text-fg-subtle">(you)</span>}
            </p>
            <Badge tone={managedUser.role === "admin" ? "accent" : "neutral"}>{managedUser.role}</Badge>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => toggleRole.mutate()} disabled={toggleRole.isPending || isSelf}>
            {managedUser.role === "admin" ? "Make user" : "Make admin"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setResetting((v) => !v)}>
            Reset password
          </Button>
          {!isSelf && <DeleteButton title="Delete account" onDelete={() => remove.mutate()} />}
        </div>
      </div>
      {resetting && (
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-border pt-2.5">
          <Input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
            className="h-8 flex-1 text-xs"
          />
          <Button variant="primary" size="sm" onClick={() => resetPassword.mutate()} disabled={resetPassword.isPending || newPassword.length < 8}>
            Set
          </Button>
        </div>
      )}
    </Card>
  );
}

export function UsersPage() {
  const { user } = useAuth();
  const [showForm, setShowForm] = useState(false);

  const { data } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<{ users: ManagedUser[] }>("/users"),
  });

  const managedUsers = data?.users ?? [];

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-1 flex items-center gap-2">
        <UsersIcon size={18} className="text-accent" />
        <h1 className="text-xl font-semibold text-fg">Users</h1>
      </div>
      <p className="mb-6 text-sm text-fg-muted">
        Admins see and manage everything. A user account only sees projects it's been granted access to from that
        project's page.
      </p>

      {showForm ? (
        <div className="mb-6">
          <NewUserForm onDone={() => setShowForm(false)} />
        </div>
      ) : (
        <Button variant="primary" className="mb-6" onClick={() => setShowForm(true)}>
          <Plus size={14} /> New account
        </Button>
      )}

      <div className="space-y-2">
        {managedUsers.map((u) => (
          <UserRow key={u.id} managedUser={u} isSelf={u.id === user?.id} />
        ))}
      </div>
    </div>
  );
}
