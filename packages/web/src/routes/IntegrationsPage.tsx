import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, KeyRound, Plug, Plus } from "lucide-react";
import { api } from "../lib/api";
import type { Agent, McpServer } from "../lib/types";
import { Avatar, Badge, Button, Card, Input, Label, Textarea } from "../components/ui";
import { DeleteButton } from "../components/DeleteButton";
import { ConnectorCatalog } from "../components/ConnectorCatalog";

interface OAuthApp {
  service: "google" | "slack";
  clientId: string;
  secretHint: string;
}

const OAUTH_SERVICE_LABEL: Record<OAuthApp["service"], string> = { google: "Google", slack: "Slack" };

function OAuthAppForm({ defaultService, onDone }: { defaultService: OAuthApp["service"]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [service, setService] = useState<OAuthApp["service"]>(defaultService);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const redirectUri = `${window.location.origin}/api/oauth/${service}/callback`;

  const save = useMutation({
    mutationFn: () => api.post("/oauth/apps", { service, clientId, clientSecret }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      onDone();
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    save.mutate();
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <Label>Service</Label>
          <select
            value={service}
            onChange={(e) => setService(e.target.value as OAuthApp["service"])}
            className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="google">Google (Gmail, Drive)</option>
            <option value="slack">Slack</option>
          </select>
        </div>
        <p className="text-xs text-fg-subtle">
          Register your own OAuth app in the {service === "google" ? "Google Cloud Console" : "Slack API dashboard"} with
          this exact redirect URI, then paste its credentials below:
        </p>
        <p className="mono select-all rounded-md bg-bg-sunken px-2.5 py-1.5 text-xs text-fg-muted">{redirectUri}</p>
        <div>
          <Label>Client ID</Label>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} required className="mono" />
        </div>
        <div>
          <Label>Client secret</Label>
          <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} required className="mono" />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function OAuthAppsSection({ defaultOpen, presetService }: { defaultOpen: boolean; presetService: OAuthApp["service"] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  const [showForm, setShowForm] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) {
      setOpen(true);
      setShowForm(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultOpen]);

  const { data } = useQuery({
    queryKey: ["oauth-apps"],
    queryFn: () => api.get<{ apps: OAuthApp[] }>("/oauth/apps"),
  });

  const remove = useMutation({
    mutationFn: (service: string) => api.delete(`/oauth/apps/${service}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["oauth-apps"] }),
  });

  const apps = data?.apps ?? [];

  return (
    <div className="mt-6">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        OAuth apps — needed for Gmail, Drive, Slack
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          {apps.map((a) => (
            <Card key={a.service} className="flex items-center justify-between p-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <KeyRound size={14} className="flex-shrink-0 text-accent" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{OAUTH_SERVICE_LABEL[a.service]}</p>
                  <p className="mono truncate text-xs text-fg-subtle">
                    {a.clientId} · {a.secretHint}
                  </p>
                </div>
              </div>
              <DeleteButton title="Remove OAuth app" onDelete={() => remove.mutate(a.service)} />
            </Card>
          ))}
          {showForm ? (
            <OAuthAppForm defaultService={presetService} onDone={() => setShowForm(false)} />
          ) : (
            <Button variant="secondary" onClick={() => setShowForm(true)}>
              <Plus size={14} /> Add OAuth app
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function parseLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function NewServerForm({ agents, onDone }: { agents: Agent[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [secretText, setSecretText] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const create = useMutation({
    mutationFn: () =>
      api.post("/mcp-servers", {
        name,
        agentId: agentId || null,
        transport,
        command: transport === "stdio" ? command : undefined,
        args: transport === "stdio" ? args.split(/\s+/).filter(Boolean) : undefined,
        env: transport === "stdio" ? parseLines(secretText) : undefined,
        url: transport === "sse" ? url : undefined,
        headers: transport === "sse" ? parseLines(secretText) : undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      onDone();
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    create.mutate();
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Salesforce" required />
        </div>
        <div>
          <Label>Available to</Label>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="">Every employee (global)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} only
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Transport</Label>
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as "stdio" | "sse")}
            className="h-9 w-full rounded-md border border-border bg-bg-raised px-3 text-sm text-fg outline-none focus:border-accent"
          >
            <option value="stdio">stdio — run a local command</option>
            <option value="sse">sse — connect to a remote server URL</option>
          </select>
        </div>
        {transport === "stdio" ? (
          <>
            <div>
              <Label>Command</Label>
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="mono" required />
            </div>
            <div>
              <Label>Arguments (space-separated)</Label>
              <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @some/mcp-server" className="mono" />
            </div>
            <div>
              <Label>Environment variables (one KEY=value per line)</Label>
              <Textarea value={secretText} onChange={(e) => setSecretText(e.target.value)} rows={3} className="mono" />
            </div>
          </>
        ) : (
          <>
            <div>
              <Label>Server URL</Label>
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…/sse"
                className="mono"
                required
              />
            </div>
            <div>
              <Label>Headers (one KEY=value per line)</Label>
              <Textarea value={secretText} onChange={(e) => setSecretText(e.target.value)} rows={3} className="mono" />
            </div>
          </>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? "Connecting…" : "Add server"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ServerRow({ server, agentName }: { server: McpServer; agentName: string | undefined }) {
  const queryClient = useQueryClient();

  const toggle = useMutation({
    mutationFn: () => api.patch(`/mcp-servers/${server.id}`, { enabled: !server.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/mcp-servers/${server.id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  return (
    <Card className="flex items-center justify-between p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar label={server.name} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{server.name}</p>
          <p className="mono truncate text-xs text-fg-subtle">
            {server.transport}
            {server.transport === "stdio" ? ` · ${server.command} ${server.args.join(" ")}` : ` · ${server.url}`}
          </p>
        </div>
        <Badge tone="neutral">{server.agentId ? agentName ?? "one employee" : "global"}</Badge>
        {!server.enabled && <Badge tone="warning">disabled</Badge>}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
          {server.enabled ? "Disable" : "Enable"}
        </Button>
        <DeleteButton title="Remove server" onDelete={() => remove.mutate()} />
      </div>
    </Card>
  );
}

export function IntegrationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const setupOAuth = searchParams.get("setupOAuth");
  const presetService: OAuthApp["service"] = setupOAuth === "slack" ? "slack" : "google";

  useEffect(() => {
    if (!setupOAuth) return;
    const next = new URLSearchParams(searchParams);
    next.delete("setupOAuth");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupOAuth]);

  const { data: servers } = useQuery({
    queryKey: ["mcp-servers", "global"],
    queryFn: () => api.get<{ servers: McpServer[] }>("/mcp-servers"),
  });

  const { data: agentsData } = useQuery({
    queryKey: ["agents", "all"],
    queryFn: () => api.get<{ agents: Agent[] }>("/agents"),
  });

  const agents = agentsData?.agents ?? [];
  const agentName = (id: string | null) => agents.find((a) => a.id === id)?.name;
  const connectedServers = servers?.servers ?? [];

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-1 flex items-center gap-2">
        <Plug size={18} className="text-accent" />
        <h1 className="text-xl font-semibold text-fg">Browse connectors</h1>
      </div>
      <p className="mb-6 text-sm text-fg-muted">
        Give employees tools beyond files, shell, and the web. Global connectors are available to everyone — to scope
        one to a single employee, connect it from that employee's own settings instead.
      </p>

      <ConnectorCatalog />
      <OAuthAppsSection defaultOpen={!!setupOAuth} presetService={presetService} />

      {connectedServers.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Connected servers</h2>
          <div className="space-y-2">
            {connectedServers.map((s) => (
              <ServerRow key={s.id} server={s} agentName={agentName(s.agentId)} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-8">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
        >
          <ChevronDown size={13} className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
          Advanced: custom server
        </button>
        {showAdvanced && (
          <div className="mt-3">
            {showForm ? (
              <NewServerForm agents={agents} onDone={() => setShowForm(false)} />
            ) : (
              <Button variant="secondary" onClick={() => setShowForm(true)}>
                <Plus size={14} /> Add custom MCP server
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
