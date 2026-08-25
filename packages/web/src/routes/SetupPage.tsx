import { useState, type FormEvent } from "react";
import { useAuth, ApiError } from "../lib/auth";
import { api } from "../lib/api";
import { Button, Input, Label } from "../components/ui";

export function SetupPage() {
  const { bootstrap } = useAuth();
  const [step, setStep] = useState<"account" | "connectors">("account");
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
    try { await bootstrap(email, password); setStep("connectors"); } catch (err) { setError(err instanceof ApiError ? err.message : "Založení selhalo"); } finally { setSubmitting(false); }
  }

  if (step === "connectors") return <ConnectorsStep />;

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4 py-8">
      <form onSubmit={onAccountSubmit} className="w-full max-w-[420px] rounded-[18px] border border-border bg-bg-raised p-6 shadow-sm md:p-7">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center bg-fg text-bg-raised mono text-[12px] font-[700] tracking-[0.08em]">H</div>
          <div className="leading-none">
            <p className="mono text-[11px] font-[700] tracking-[0.16em] text-fg">HERTZ</p>
            <p className="mono text-[10px] font-[500] tracking-[0.1em] text-fg-subtle">NASTAVENÍ</p>
          </div>
        </div>

        <h1 className="font-display text-[22px] leading-none tracking-[-0.03em] text-fg">Založ admin účet</h1>
        <p className="mono mt-1.5 text-[11px] leading-relaxed text-fg-muted">Běží jen u tebe — žádný cloud. V dalším kroku přidáš poskytovatele modelu.</p>

        <div className="mt-6 space-y-3">
          <div><Label>EMAIL</Label><Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@firma.cz" /></div>
          <div><Label>HESLO</Label><Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <div><Label>POTVRĎ HESLO</Label><Input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
        </div>

        {error && <p className="mt-3 rounded-[8px] border border-danger/20 bg-danger-wash px-3 py-2 mono text-[12px] text-danger">{error}</p>}

        <Button type="submit" variant="primary" size="md" disabled={submitting} className="mt-5 w-full">
          {submitting ? "Zakládám…" : "Vytvořit účet → pokračovat"}
        </Button>
      </form>
    </div>
  );
}

function ConnectorsStep() {
  const [githubPat, setGithubPat] = useState("");
  const [postgresUrl, setPostgresUrl] = useState("");
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  async function saveConnector(kind: "github" | "postgres") {
    setError(undefined);
    try {
      if (kind === "github") {
        await api.post("/mcp-servers", { name: "GitHub", transport: "stdio", command: "npx", argsJson: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubPat }, enabled: true });
        setSaved((s) => [...s, "GitHub"]); setGithubPat("");
      } else {
        await api.post("/mcp-servers", { name: "PostgreSQL", transport: "stdio", command: "npx", argsJson: ["-y", "@modelcontextprotocol/server-postgres", postgresUrl], env: {}, enabled: true });
        setSaved((s) => [...s, "PostgreSQL"]); setPostgresUrl("");
      }
    } catch (err) { setError(err instanceof ApiError ? err.message : `Nepodařilo se uložit ${kind}`); }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg px-4 py-8">
      <div className="w-full max-w-[420px] rounded-[18px] border border-border bg-bg-raised p-6 shadow-sm md:p-7">
        <h1 className="font-display text-[20px] leading-none tracking-[-0.03em] text-fg">Napoj nástroje <span className="mono text-[11px] font-[500] tracking-wide text-fg-subtle">(volitelné)</span></h1>
        <p className="mono mt-1.5 text-[11px] leading-relaxed text-fg-muted">Vlož token jednou — každý bot ho hned umí použít. Další doplníš v Integracích.</p>

        {error && <p className="mt-3 rounded-[8px] border border-danger/20 bg-danger-wash px-3 py-2 mono text-[11px] text-danger">{error}</p>}
        {saved.length > 0 && <p className="mt-3 rounded-[8px] border border-live/20 bg-live-wash px-3 py-2 mono text-[11px] font-[600] text-live">Připojeno: {saved.join(", ")}</p>}

        <div className="mt-5 space-y-4">
          <div className="rounded-[12px] border border-border bg-bg-sunken p-3">
            <Label>GITHUB PAT</Label>
            <Input value={githubPat} onChange={(e) => setGithubPat(e.target.value)} placeholder="ghp_…" autoComplete="off" className="mono" />
            <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={!githubPat.trim()} onClick={() => void saveConnector("github")}>Připojit GitHub</Button>
          </div>
          <div className="rounded-[12px] border border-border bg-bg-sunken p-3">
            <Label>POSTGRESQL URL</Label>
            <Input value={postgresUrl} onChange={(e) => setPostgresUrl(e.target.value)} placeholder="postgresql://user:pass@host/db" autoComplete="off" className="mono" />
            <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={!postgresUrl.trim()} onClick={() => void saveConnector("postgres")}>Připojit PostgreSQL</Button>
          </div>
        </div>

        <Button variant="primary" size="md" className="mt-6 w-full" onClick={() => window.location.reload()}>Dokončit → otevřít Hertz</Button>
        <p className="mono mt-2 text-center text-[10px] leading-relaxed text-fg-faint">Další obrazovka: Provideři — vlož jeden AI klíč a máš hotovo.</p>
      </div>
    </div>
  );
}
