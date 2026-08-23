import { useState, type FormEvent } from "react";
import { useAuth, ApiError } from "../lib/auth";
import { api } from "../lib/api";
import { Button, Input, Label } from "../components/ui";

/**
 * First-run wizard, zero-config style:
 * 1. CEO account
 * 2. (optional) connect tools once — GitHub / PostgreSQL — saved as ready-to-use
 *    MCP servers right here, so nothing ever has to be configured by hand later.
 */
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
      setStep("connectors");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "connectors") {
    return <ConnectorsStep />;
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg-sidebar px-4">
      <form onSubmit={onAccountSubmit} className="w-full max-w-sm rounded-lg border border-border bg-bg-raised p-7 shadow-md">
        <div className="mb-6 flex items-center gap-2.5">
          <div>
            <p className="text-sm font-semibold leading-none text-fg">Hertz Jobs</p>
            <p className="text-[11px] leading-none text-fg-subtle">AI Agent Platform</p>
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

function ConnectorsStep() {
  const [githubPat, setGithubPat] = useState("");
  const [postgresUrl, setPostgresUrl] = useState("");
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  async function saveConnector(kind: "github" | "postgres") {
    setError(undefined);
    try {
      if (kind === "github") {
        await api.post("/mcp-servers", {
          name: "GitHub",
          transport: "stdio",
          command: "npx",
          argsJson: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubPat },
          enabled: true,
        });
        setSaved((s) => [...s, "GitHub"]);
        setGithubPat("");
      } else {
        await api.post("/mcp-servers", {
          name: "PostgreSQL",
          transport: "stdio",
          command: "npx",
          argsJson: ["-y", "@modelcontextprotocol/server-postgres", postgresUrl],
          env: {},
          enabled: true,
        });
        setSaved((s) => [...s, "PostgreSQL"]);
        setPostgresUrl("");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Couldn't save ${kind} connector`);
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg-sidebar px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-border bg-bg-raised p-7 shadow-md">
        <h1 className="mb-1 text-base font-semibold text-fg">Connect tools (optional)</h1>
        <p className="mb-5 text-sm text-fg-muted">
          Paste a token once and every bot can use it immediately. You can add more apps later under Integrations — nothing else ever needs manual config.
        </p>

        {error && <p className="mb-3 rounded-md bg-danger-wash p-2 text-xs text-danger">{error}</p>}
        {saved.length > 0 && (
          <p className="mb-4 rounded-md bg-success-wash p-2 text-xs text-success">Connected: {saved.join(", ")}</p>
        )}

        <div className="mb-5 space-y-3">
          <div>
            <Label>GitHub personal access token</Label>
            <Input value={githubPat} onChange={(e) => setGithubPat(e.target.value)} placeholder="ghp_…" autoComplete="off" />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-2"
              disabled={!githubPat.trim()}
              onClick={() => void saveConnector("github")}
            >
              Connect GitHub
            </Button>
          </div>
          <div className="pt-2">
            <Label>PostgreSQL connection URL</Label>
            <Input value={postgresUrl} onChange={(e) => setPostgresUrl(e.target.value)} placeholder="postgresql://user:pass@host/db" autoComplete="off" />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-2"
              disabled={!postgresUrl.trim()}
              onClick={() => void saveConnector("postgres")}
            >
              Connect PostgreSQL
            </Button>
          </div>
        </div>

        <Button variant="primary" size="md" className="w-full" onClick={() => window.location.reload()}>
          Finish setup → open Hertz
        </Button>
        <p className="mt-3 text-center text-xs text-fg-subtle">
          Next screen: Providers — paste one AI API key (Anthropic, OpenAI, Google, OpenRouter…) and you're done.
        </p>
      </div>
    </div>
  );
}
