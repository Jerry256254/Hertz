import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, UserCircle } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Avatar, Badge, Button, Card, Input, Label } from "../components/ui";

export function AccountPage() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [success, setSuccess] = useState(false);

  const changePassword = useMutation({
    mutationFn: () => api.patch(`/users/${user!.id}/password`, { currentPassword, newPassword }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 4000);
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match.");
      return;
    }
    changePassword.mutate();
  }

  if (!user) return null;

  return (
    <div className="mx-auto max-w-lg px-6 py-10">
      <div className="mb-1 flex items-center gap-2">
        <UserCircle size={18} className="text-accent" />
        <h1 className="text-xl font-semibold text-fg">Account</h1>
      </div>
      <p className="mb-6 text-sm text-fg-muted">Your login and password.</p>

      <Card className="mb-6 flex items-center gap-3 p-4">
        <Avatar label={user.email} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{user.email}</p>
          <Badge tone={user.role === "admin" ? "accent" : "neutral"}>{user.role}</Badge>
        </div>
      </Card>

      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
        <KeyRound size={12} /> Change password
      </h2>
      <Card className="p-4">
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label>Current password</Label>
            <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          </div>
          <div>
            <Label>New password</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required />
          </div>
          <div>
            <Label>Confirm new password</Label>
            <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} required />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          {success && <p className="text-xs text-success">Password updated.</p>}
          <Button type="submit" variant="primary" disabled={changePassword.isPending}>
            {changePassword.isPending ? "Saving…" : "Update password"}
          </Button>
        </form>
      </Card>

      <DangerZone />
    </div>
  );
}

function DangerZone() {
  const [confirm, setConfirm] = useState("");
  const [phase, setPhase] = useState<"idle" | "resetting">("idle");

  async function doReset() {
    setPhase("resetting");
    try {
      await api.post("/admin/reset", { confirm: "RESET" });
    } catch {
      /* server is going down either way */
    }
    // Poll until the server comes back as a fresh install, then reload.
    const started = Date.now();
    const poll = setInterval(async () => {
      try {
        const res = await fetch("/api/setup/status");
        if (res.ok) {
          const body = (await res.json()) as { needsSetup: boolean };
          if (body.needsSetup || Date.now() - started > 30_000) {
            clearInterval(poll);
            window.location.reload();
          }
        }
      } catch {
        /* still restarting */
      }
    }, 1_500);
  }

  return (
    <Card className="border-danger/40 p-4">
      <p className="text-sm font-medium text-danger">Danger zone</p>
      <p className="mb-3 text-xs text-fg-muted">
        Factory reset: wipes ALL data — account, chats, memory, skills, provider keys, agent containers — and
        restarts into a fresh first-run setup, like a brand-new download. This cannot be undone.
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder='Type "RESET" to confirm'
          className="h-9 max-w-xs text-sm"
        />
        <Button variant="danger" size="sm" disabled={confirm !== "RESET" || phase === "resetting"} onClick={() => void doReset()}>
          {phase === "resetting" ? "Resetting…" : "Reset Hertz Jobs"}
        </Button>
      </div>
      {phase === "resetting" && <p className="mt-2 text-xs text-fg-muted">Server is restarting — this page reloads automatically.</p>}
    </Card>
  );
}
