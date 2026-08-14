import { useState, type FormEvent } from "react";
import { useAuth, ApiError } from "../lib/auth";
import { Button, Input, Label } from "../components/ui";

export function SetupPage() {
  const { bootstrap } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await bootstrap(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg-sidebar px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg border border-border bg-bg-raised p-7 shadow-md">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg">
            H
          </span>
          <div>
            <p className="text-sm font-semibold leading-none text-fg">Hertz</p>
            <p className="text-[11px] leading-none text-fg-subtle">by KucLab</p>
          </div>
        </div>

        <h1 className="mb-1 text-base font-semibold text-fg">Create your admin account</h1>
        <p className="mb-6 text-sm text-fg-muted">
          This runs on your own machine — no cloud account, no telemetry. You'll add a model provider next.
        </p>

        <div className="mb-3">
          <Label>Email</Label>
          <Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="mb-3">
          <Label>Password</Label>
          <Input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="mb-5">
          <Label>Confirm password</Label>
          <Input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        {error && <p className="mb-3 text-xs text-danger">{error}</p>}

        <Button type="submit" variant="primary" size="md" disabled={submitting} className="w-full">
          {submitting ? "Creating account…" : "Create account & continue"}
        </Button>
      </form>
    </div>
  );
}
