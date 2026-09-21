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
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))]">
      <form onSubmit={onSubmit} className="w-full max-w-[380px] rounded-[24px] border border-border bg-bg-raised p-6 shadow-sm md:p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-[15px] font-[800] text-white">H</div>
          <div className="leading-none">
            <p className="text-[12px] font-[800] tracking-[0.14em] text-fg">HERTZ</p>
            <p className="mt-1 text-[10px] font-[600] tracking-[0.1em] text-fg-subtle">OSOBNÍ AGENT</p>
          </div>
        </div>

        <h1 className="text-[22px] tracking-[-0.02em] text-fg">Přihlášení</h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">Běží lokálně na tvém stroji — bez cloudu, bez telemetrie.</p>

        <div className="mt-6 space-y-3">
          <div>
            <Label htmlFor="login-email">EMAIL</Label>
            <Input id="login-email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jmeno@firma.cz" />
          </div>
          <div>
            <Label htmlFor="login-password">HESLO</Label>
            <Input id="login-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>

        {error && <p className="mt-3 rounded-[14px] border border-danger/20 bg-danger-wash px-4 py-2.5 text-[12.5px] text-danger">{error}</p>}

        <Button type="submit" variant="primary" size="md" disabled={submitting} className="mt-5 w-full">
          {submitting ? "Přihlašuji…" : "Přihlásit se"}
        </Button>
        <p className="mt-3 text-center text-[11px] leading-relaxed text-fg-faint">chráněno lokálním účtem · data zůstávají u tebe</p>
      </form>
    </div>
  );
}
