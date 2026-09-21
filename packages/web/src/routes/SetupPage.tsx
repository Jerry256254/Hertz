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

  async function onAccountSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (password.length < 8) { setError("Heslo musí mít alespoň 8 znaků."); return; }
    if (password !== confirm) { setError("Hesla se neshodují."); return; }
    setSubmitting(true);
    try { await bootstrap(email, password); } catch (err) { setError(err instanceof ApiError ? err.message : "Založení selhalo"); } finally { setSubmitting(false); }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4 py-8">
      <form onSubmit={onAccountSubmit} className="w-full max-w-[420px] rounded-[24px] border border-border bg-bg-raised p-6 shadow-sm md:p-8">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-[15px] font-[800] text-white">M</div>
          <div className="leading-none">
            <p className="text-[12px] font-[800] tracking-[0.14em] text-fg">HERTZ</p>
            <p className="mt-1 text-[10px] font-[600] tracking-[0.1em] text-fg-subtle">NASTAVENÍ</p>
          </div>
        </div>

        <h1 className="text-[22px] tracking-[-0.02em] text-fg">Založ admin účet</h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">Běží jen u tebe — žádný cloud. V dalším kroku si vybereš model a dáme si jména.</p>

        <div className="mt-6 space-y-3.5">
          <div><Label>EMAIL</Label><Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@firma.cz" /></div>
          <div><Label>HESLO</Label><Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <div><Label>POTVRĎ HESLO</Label><Input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
        </div>

        {error && <p className="mt-3 rounded-[14px] border border-danger/20 bg-danger-wash px-4 py-2.5 text-[12.5px] text-danger">{error}</p>}

        <Button type="submit" variant="primary" size="md" disabled={submitting} className="mt-5 w-full">
          {submitting ? "Zakládám…" : "Vytvořit účet → pokračovat"}
        </Button>
      </form>
    </div>
  );
}
