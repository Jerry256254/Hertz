import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { ModelInfo, PresetCategory, ProviderConfig, ProviderKey, ProviderPreset } from "../lib/types";
import { Avatar, Badge, Button, Card, IconButton, Input, Label } from "../components/ui";
import { DeleteButton } from "../components/DeleteButton";

const CATEGORY_LABEL: Record<PresetCategory, string> = {
  frontier: "Frontier labs",
  aggregator: "Aggregators & inference clouds",
  local: "Local & self-hosted",
};

function AddProviderForm({ preset, onDone }: { preset: ProviderPreset; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(preset.name);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl ?? "");
  const [error, setError] = useState<string | undefined>(undefined);

  const createProvider = useMutation({
    mutationFn: () =>
      api.post("/providers", {
        provider: preset.kind,
        label,
        apiKey,
        baseUrl: preset.kind === "openai-compatible" ? baseUrl : undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      onDone();
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    createProvider.mutate();
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <Avatar label={preset.name} tone="accent" />
        <div>
          <p className="text-sm font-medium text-fg">{preset.name}</p>
          <p className="mono text-xs text-fg-subtle">{preset.hint}</p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <Label>Label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
        </div>
        {preset.kind === "openai-compatible" && (
          <div>
            <Label>Base URL</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…/v1"
              required
              className="mono"
            />
          </div>
        )}
        <div>
          <Label>API key</Label>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoFocus placeholder="optional for free gateways" />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={createProvider.isPending}>
            {createProvider.isPending ? "Saving…" : "Add provider"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function KeyPool({ providerId }: { providerId: string }) {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const { data } = useQuery({
    queryKey: ["provider-keys", providerId],
    queryFn: () => api.get<{ keys: ProviderKey[] }>(`/providers/${providerId}/keys`),
  });

  const addKey = useMutation({
    mutationFn: () => api.post(`/providers/${providerId}/keys`, { apiKey: newKey }),
    onSuccess: () => {
      setNewKey("");
      void queryClient.invalidateQueries({ queryKey: ["provider-keys", providerId] });
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const removeKey = useMutation({
    mutationFn: (keyId: string) => api.delete(`/providers/${providerId}/keys/${keyId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["provider-keys", providerId] });
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (newKey.trim()) addKey.mutate();
  }

  const keys = data?.keys ?? [];

  return (
    <div className="mt-2.5 border-t border-border pt-2.5">
      <p className="mb-2 text-xs text-fg-subtle">
        Extra keys let this provider rotate to the next one automatically when a request hits a rate limit — useful if
        you have several accounts.
      </p>
      {keys.length > 0 && (
        <ul className="mb-2 space-y-1">
          {keys.map((k) => (
            <li key={k.id} className="mono flex items-center justify-between rounded-md bg-bg-sunken px-2.5 py-1.5 text-xs text-fg-muted">
              {k.keyHint}
              <DeleteButton title="Remove this key" onDelete={() => removeKey.mutate(k.id)} />
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={onSubmit} className="flex gap-1.5">
        <Input
          type="password"
          placeholder="Additional API key"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          className="h-8 flex-1 text-xs"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={addKey.isPending || !newKey.trim()}>
          <Plus size={13} /> Add key
        </Button>
      </form>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}

function ConfiguredProviderRow({ provider }: { provider: ProviderConfig }) {
  const queryClient = useQueryClient();
  const [models, setModels] = useState<ModelInfo[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showKeys, setShowKeys] = useState(false);

  const scan = useMutation({
    mutationFn: () => api.post<{ models: ModelInfo[] }>(`/providers/${provider.id}/scan`),
    onSuccess: (res) => setModels(res.models),
    onError: (err) => setError((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/providers/${provider.id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["providers"] }),
    onError: (err) => setError((err as Error).message),
  });

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar label={provider.label} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{provider.label}</p>
            <p className="mono truncate text-xs text-fg-subtle">
              {provider.provider} · {provider.keyHint}
            </p>
          </div>
          {provider.keyCount > 1 && <Badge tone="neutral">{provider.keyCount} keys</Badge>}
        </div>
        {confirmingDelete ? (
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <span className="text-xs text-fg-muted">Delete this provider?</span>
            <Button variant="danger" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
              {scan.isPending ? "Scanning…" : "Scan models"}
            </Button>
            <IconButton title="Manage keys" onClick={() => setShowKeys((v) => !v)}>
              <KeyRound size={14} />
            </IconButton>
            <IconButton title="Delete provider" onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {showKeys && <KeyPool providerId={provider.id} />}
      {models && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-border pt-2.5">
          {models.length === 0 && <span className="text-xs text-fg-subtle">No models returned.</span>}
          {models.map((m) => (
            <Badge key={m.id} tone="neutral" className="mono">
              {m.id}
            </Badge>
          ))}
        </div>
      )}
    </Card>
  );
}

export function ProvidersPage() {
  const [query, setQuery] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | undefined>(undefined);

  const { data: configured } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });

  const { data: presetsData } = useQuery({
    queryKey: ["provider-presets"],
    queryFn: () => api.get<{ presets: ProviderPreset[] }>("/setup/presets"),
  });

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (presetsData?.presets ?? []).filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.hint.toLowerCase().includes(q),
    );
    const groups: Record<PresetCategory, ProviderPreset[]> = { frontier: [], aggregator: [], local: [] };
    for (const p of filtered) groups[p.category].push(p);
    return groups;
  }, [presetsData, query]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="mb-1 text-xl font-semibold text-fg">Providers</h1>
      <p className="mb-6 text-sm text-fg-muted">
        Bring your own API key for any provider. Keys are encrypted at rest and never sent back to the browser.
      </p>

      {configured && configured.providers.length > 0 && (
        <div className="mb-8 space-y-2">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Configured</h2>
          {configured.providers.map((p) => (
            <ConfiguredProviderRow key={p.id} provider={p} />
          ))}
        </div>
      )}

      <MistralOAuthCard />

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Add a provider</h2>

      <div className="relative mb-4">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <Input
          placeholder="Search providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8"
        />
      </div>

      {selectedPreset ? (
        <AddProviderForm preset={selectedPreset} onDone={() => setSelectedPreset(undefined)} />
      ) : (
        <div className="space-y-5">
          {(Object.keys(grouped) as PresetCategory[]).map((category) =>
            grouped[category].length === 0 ? null : (
              <div key={category}>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                  {CATEGORY_LABEL[category]}
                </p>
                <Card className="divide-y divide-border overflow-hidden">
                  {grouped[category].map((preset) => {
                    const isConfigured = configured?.providers.some(
                      (p) => p.provider === preset.kind && (p.baseUrl ?? "") === (preset.baseUrl ?? "") && p.label === preset.name,
                    );
                    return (
                      <button
                        key={preset.id}
                        onClick={() => setSelectedPreset(preset)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-hover"
                      >
                        <Avatar label={preset.name} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-fg">{preset.name}</p>
                          <p className="mono truncate text-xs text-fg-subtle">{preset.hint}</p>
                        </div>
                        {isConfigured ? (
                          <Check size={14} className="flex-shrink-0 text-success" />
                        ) : (
                          <KeyRound size={13} className="flex-shrink-0 text-fg-subtle" />
                        )}
                      </button>
                    );
                  })}
                </Card>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}


function MistralOAuthCard() {
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState("");
  const connected = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mistralConnected");

  const saveApp = useMutation({
    mutationFn: () => api.post("/oauth/apps", { service: "mistral", clientId: clientId.trim(), clientSecret: "" }),
    onSuccess: () => {
      window.location.href = "/api/oauth/mistral/start";
    },
  });

  function signIn() {
    if (clientId.trim()) {
      saveApp.mutate();
    } else {
      // Client ID already stored from a previous run — go straight to consent.
      window.location.href = "/api/oauth/mistral/start";
    }
  }

  return (
    <Card className="mb-8 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={15} className="text-accent" />
        <p className="text-sm font-medium text-fg">Sign in with Mistral (Le Pro)</p>
      </div>
      {connected && (
        <p className="mb-3 rounded-md bg-success-wash p-2 text-xs text-success">
          Mistral account connected — a &quot;Mistral (Le Pro — OAuth)&quot; provider was added below.
        </p>
      )}
      <p className="mb-3 text-xs text-fg-muted">
        Use your Mistral Pro subscription instead of an API key. Paste your OAuth Client ID once (La Plateforme →
        API Keys → OAuth apps), then sign in — tokens are refreshed automatically.
      </p>
      <div className="flex items-center gap-2">
        <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="OAuth Client ID" className="h-9 max-w-xs text-sm" />
        <Button size="sm" variant="primary" onClick={signIn} disabled={saveApp.isPending}>
          Sign in with Mistral
        </Button>
      </div>
    </Card>
  );
}
