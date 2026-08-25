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
    try { await login(email, password); } catch (err) { setError(err instanceof ApiError ? err.message : "Přihlášení selhalo"); } finally { setSubmitting(false); }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4 py-8">
      <form onSubmit={onSubmit} className="w-full max-w-[380px] rounded-[18px] border border-border bg-bg-raised p-6 shadow-sm md:p-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center bg-fg text-bg-raised mono text-[12px] font-[700] tracking-[0.08em]">H</div>
          <div className="leading-none">
            <p className="mono text-[11px] font-[700] tracking-[0.16em] text-fg">HERTZ</p>
            <p className="mono text-[10px] font-[500] tracking-[0.1em] text-fg-subtle">WORKSPACE</p>
          </div>
        </div>

        <h1 className="font-display text-[22px] leading-none tracking-[-0.03em] text-fg">Přihlášení</h1>
        <p className="mono mt-1.5 text-[11px] leading-relaxed text-fg-muted">Běží lokálně na tvém stroji — bez cloudu, bez telemetrie.</p>

        <div className="mt-6 space-y-3">
          <div>
            <Label>EMAIL</Label>
            <Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@firma.cz" />
          </div>
          <div>
            <Label>HESLO</Label>
            <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>

        {error && <p className="mt-3 rounded-[8px] border border-danger/20 bg-danger-wash px-3 py-2 mono text-[12px] text-danger">{error}</p>}

        <Button type="submit" variant="primary" size="md" disabled={submitting} className="mt-5 w-full">
          {submitting ? "Přihlašuji…" : "Přihlásit se"}
        </Button>
        <p className="mono mt-3 text-center text-[10px] leading-relaxed tracking-wide text-fg-faint">chráněno lokálním účtem · data zůstávají u tebe</p>
      </form>
    </div>
  );
}
