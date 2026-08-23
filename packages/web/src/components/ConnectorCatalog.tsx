import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Search, TriangleAlert, X } from "lucide-react";
import { api } from "../lib/api";
import type { McpServer } from "../lib/types";
import { MCP_CATALOG, MCP_CATEGORY_LABEL, type McpCatalogEntry } from "../lib/mcp-catalog";
import { Badge, Button, Card, Input, Label } from "./ui";

function ConnectDialog({
  entry,
  scopeAgentId,
  onOpenChange,
  onConnected,
}: {
  entry: McpCatalogEntry;
  scopeAgentId: string | undefined;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  const connect = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        name: entry.name,
        agentId: scopeAgentId ?? null,
        transport: entry.transport,
      };
      if (entry.transport === "stdio") {
        payload.command = entry.command;
        payload.args = entry.args;
        if (entry.credentials.length > 0) payload.env = values;
      } else {
        payload.url = entry.url;
        if (entry.credentials.length > 0) payload.headers = values;
      }
      return api.post("/mcp-servers", payload);
    },
    onSuccess: onConnected,
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    connect.mutate();
  }

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-raised shadow-popover">
          <div className="flex h-12 items-center justify-between border-b border-border px-4">
            <Dialog.Title className="text-sm font-semibold text-fg">Connect {entry.name}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-fg-muted hover:text-fg">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <form onSubmit={onSubmit} className="space-y-3 p-4">
            <p className="text-xs text-fg-subtle">{entry.description}</p>
            {entry.credentials.length === 0 ? (
              <p className="text-xs text-fg-muted">No credentials needed — this server runs locally.</p>
            ) : (
              entry.credentials.map((field) => (
                <div key={field.key}>
                  <Label>{field.label}</Label>
                  <Input
                    type={field.secret ? "password" : "text"}
                    placeholder={field.placeholder}
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    required
                    className="mono"
                  />
                  {field.helpText && <p className="mt-1 text-[11px] text-fg-subtle">{field.helpText}</p>}
                </div>
              ))
            )}
            {error && <p className="text-xs text-danger">{error}</p>}
            <Button type="submit" variant="primary" className="w-full" disabled={connect.isPending}>
              {connect.isPending ? "Connecting…" : "Connect"}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface OAuthApp {
  service: "google" | "slack" | "grok";
  clientId: string;
  secretHint: string;
}

/**
 * Tile-based connector browser, modeled on Claude's own connector directory.
 * Entries with a real OAuth app configured (see the "OAuth apps" section on
 * the Integrations page) redirect straight to the provider's consent screen;
 * everything else opens a small form asking for exactly the credential its
 * server needs. Reused both globally (scopeAgentId undefined) and scoped to
 * one employee's own settings.
 */
export function ConnectorCatalog({ scopeAgentId, projectId }: { scopeAgentId?: string; projectId?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | McpCatalogEntry["category"]>("all");
  const [connecting, setConnecting] = useState<McpCatalogEntry | undefined>(undefined);

  const connectedNotice = searchParams.get("connected");
  const oauthError = searchParams.get("oauthError");

  useEffect(() => {
    if (!connectedNotice && !oauthError) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      next.delete("connected");
      next.delete("oauthError");
      setSearchParams(next, { replace: true });
    }, 6000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedNotice, oauthError]);

  const queryKey = ["mcp-servers", scopeAgentId ?? "global"];
  const { data } = useQuery({
    queryKey,
    queryFn: () => api.get<{ servers: McpServer[] }>(`/mcp-servers${scopeAgentId ? `?agentId=${scopeAgentId}` : ""}`),
  });
  const rows = data?.servers ?? [];

  const { data: oauthAppsData } = useQuery({
    queryKey: ["oauth-apps"],
    queryFn: () => api.get<{ apps: OAuthApp[] }>("/oauth/apps"),
  });
  const configuredServices = new Set((oauthAppsData?.apps ?? []).map((a) => a.service));

  function isConnected(entry: McpCatalogEntry): boolean {
    return rows.some((s) => {
      // Matching on command alone isn't enough — most catalog entries share "npx" as
      // the command, so args (which actually identify the package, e.g. server-github
      // vs. server-postgres) must match too, or connecting any one npx-based server
      // would falsely mark every other npx-based entry as connected too.
      const matches = entry.oauth
        ? s.name === entry.name
        : entry.transport === "stdio"
          ? s.transport === "stdio" && s.command === entry.command && JSON.stringify(s.args) === JSON.stringify(entry.args)
          : s.transport === "sse" && s.url === entry.url;
      return matches && (s.agentId ?? null) === (scopeAgentId ?? null);
    });
  }

  function onConnectClick(entry: McpCatalogEntry) {
    if (!entry.oauth) {
      setConnecting(entry);
      return;
    }
    if (!configuredServices.has(entry.oauth.service)) {
      navigate(`/integrations?setupOAuth=${entry.oauth.service}`);
      return;
    }
    const params = new URLSearchParams({ catalogId: entry.id });
    if (scopeAgentId) params.set("agentId", scopeAgentId);
    if (projectId) params.set("projectId", projectId);
    window.location.href = `/api/oauth/${entry.oauth.service}/start?${params.toString()}`;
  }

  const filtered = MCP_CATALOG.filter((e) => {
    if (category !== "all" && e.category !== category) return false;
    const q = query.trim().toLowerCase();
    return !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
  });

  const categories: Array<"all" | McpCatalogEntry["category"]> = ["all", "development", "productivity", "communication", "data"];

  return (
    <div>
      {connectedNotice && (
        <p className="mb-3 flex items-center gap-1.5 rounded-md border border-success/30 bg-success-wash px-3 py-1.5 text-xs text-success">
          <Check size={13} /> Connected {connectedNotice}.
        </p>
      )}
      {oauthError && (
        <p className="mb-3 flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-wash px-3 py-1.5 text-xs text-danger">
          <TriangleAlert size={13} /> Couldn't connect: {oauthError}
        </p>
      )}

      <div className="relative mb-3">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <Input placeholder="Search connectors…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              category === c ? "bg-accent text-accent-fg" : "bg-bg-sunken text-fg-muted hover:text-fg"
            }`}
          >
            {c === "all" ? "All" : MCP_CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {filtered.map((entry) => {
          const connected = isConnected(entry);
          const needsOAuthSetup = !!entry.oauth && !configuredServices.has(entry.oauth.service);
          return (
            <Card key={entry.id} className="p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-bg-sunken text-sm font-semibold text-fg-muted">
                    {entry.letter}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{entry.name}</p>
                    {entry.oauth && <Badge tone="neutral">OAuth</Badge>}
                  </div>
                </div>
                {connected ? (
                  <span className="flex flex-shrink-0 items-center gap-1 text-xs text-success">
                    <Check size={12} /> Connected
                  </span>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => onConnectClick(entry)} className="flex-shrink-0">
                    {needsOAuthSetup ? "Needs setup" : "Connect"}
                  </Button>
                )}
              </div>
              <p className="text-xs leading-snug text-fg-subtle">{entry.description}</p>
            </Card>
          );
        })}
      </div>

      {connecting && (
        <ConnectDialog
          entry={connecting}
          scopeAgentId={scopeAgentId}
          onOpenChange={(open) => !open && setConnecting(undefined)}
          onConnected={() => {
            void queryClient.invalidateQueries({ queryKey });
            setConnecting(undefined);
          }}
        />
      )}
    </div>
  );
}
