import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Terminal, UserCircle, Wallet } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Avatar, Badge, Button, Card, Input, Label } from "../components/ui";
import { DeleteButton } from "../components/DeleteButton";

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

      <MonthlyUsage />
      <ApiTokens />

      <DangerZone />
    </div>
  );
}

function MonthlyUsage() {
  const { data } = useQuery({
    queryKey: ["usage-monthly"],
    queryFn: () => api.get<{ spend: number; budget: number | null; monthStart: string }>("/usage/monthly"),
  });
  if (!data) return null;
  const pct = data.budget ? Math.min(100, (data.spend / data.budget) * 100) : 0;
  return (
    <div className="mt-8">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
        <Wallet size={12} /> Monthly AI spend
      </h2>
      <Card className="p-4">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-[700] text-fg">${data.spend.toFixed(2)}</span>
          <span className="text-xs text-fg-muted">{data.budget ? `of $${data.budget.toFixed(2)} budget` : "no budget cap"}</span>
        </div>
        {data.budget && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-sunken">
            <div className={`h-full transition-[width] ${pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-live"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className="mono mt-2 text-[11px] text-fg-subtle">since {new Date(data.monthStart).toLocaleDateString()}</p>
      </Card>
    </div>
  );
}

interface ApiTokenItem {
  id: string;
  name: string;
  prefixHint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function ApiTokens() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ id: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data } = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api.get<{ tokens: ApiTokenItem[] }>("/tokens"),
  });

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; token: string }>("/tokens", { name }),
    onSuccess: (res) => {
      setFresh(res);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/tokens/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["api-tokens"] }),
  });

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="mt-8">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
        <Terminal size={12} /> API tokens
      </h2>
      <Card className="p-4">
        <p className="mb-3 text-xs leading-relaxed text-fg-muted">
          Long-lived <span className="mono">htz_…</span> credentials for scripts and integrations. A token acts as you —{" "}
          <span className="mono">curl -H "Authorization: Bearer htz_…" /api/sessions</span>.
        </p>
        {fresh && (
          <div className="mb-3 rounded-md border border-warning/30 bg-warning-wash p-3">
            <p className="mono mb-1.5 text-[11px] font-[600] text-warning">COPY NOW — SHOWN ONLY ONCE</p>
            <div className="flex items-center gap-2">
              <code className="mono min-w-0 flex-1 truncate rounded-md bg-bg-raised px-2 py-1.5 text-xs text-fg">{fresh.token}</code>
              <Button variant="secondary" size="sm" onClick={() => void copy(fresh.token)}>
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setFresh(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}
        <div className="mb-3 flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name, e.g. home-assistant" className="h-9 text-sm" />
          <Button variant="primary" size="sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "…" : "Create"}
          </Button>
        </div>
        <ul className="space-y-2">
          {(data?.tokens ?? []).map((t) => (
            <li key={t.id} className="flex items-center gap-2 rounded-md border border-border bg-bg-sunken px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-[600] text-fg">{t.name}</p>
                <p className="mono text-[11px] text-fg-subtle">
                  {t.prefixHint}… · {t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleString()}` : "never used"}
                </p>
              </div>
              <DeleteButton onDelete={() => revoke.mutate(t.id)} title="Revoke token" />
            </li>
          ))}
          {(data?.tokens ?? []).length === 0 && !fresh && (
            <p className="text-xs text-fg-subtle">No tokens yet.</p>
          )}
        </ul>
      </Card>
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
