import { useState, type FormEvent } from "react";
import { useAuth, ApiError } from "../lib/auth";
import { Button, Input, Label } from "../components/ui";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-gradient-bg px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-xl border border-border bg-bg-raised p-8 shadow-lg">
        <div className="mb-7 flex items-center gap-3">
          <div>
            <p className="text-xl font-semibold leading-none text-fg">Hertz Jobs</p>
            <p className="text-sm leading-none text-fg-subtle">AI Agent Platform</p>
          </div>
        </div>

        <h1 className="mb-6 text-lg font-semibold text-fg">Sign in</h1>

        <div className="mb-4">
          <Label>Email</Label>
          <Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="mb-6">
          <Label>Password</Label>
          <Input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && <p className="mb-4 text-sm text-danger">{error}</p>}

        <Button type="submit" variant="primary" size="md" disabled={submitting} className="w-full">
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
