import { useState, type FormEvent } from "react";
import { useAuth, ApiError } from "../lib/auth";

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
    <div className="flex h-full items-center justify-center">
      <form onSubmit={onSubmit} className="w-full max-w-xs rounded border border-border bg-bg-raised p-6">
        <h1 className="mb-1 font-mono text-sm font-semibold tracking-tight">kuclab hertz</h1>
        <p className="mb-5 text-xs text-fg-muted">Sign in to your instance</p>

        <label className="mb-3 block text-xs text-fg-muted">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
          />
        </label>
        <label className="mb-4 block text-xs text-fg-muted">
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
          />
        </label>

        {error && <p className="mb-3 text-xs text-danger">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
