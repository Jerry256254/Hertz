import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ModelInfo, ProviderConfig } from "../lib/types";

const PROVIDER_OPTIONS = ["anthropic", "openai", "google", "openai-compatible"] as const;

export function ProvidersPage() {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<(typeof PROVIDER_OPTIONS)[number]>("anthropic");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [scanResults, setScanResults] = useState<Record<string, ModelInfo[]>>({});

  const { data } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });

  const createProvider = useMutation({
    mutationFn: () =>
      api.post("/providers", {
        provider,
        label: label || provider,
        apiKey,
        baseUrl: provider === "openai-compatible" ? baseUrl : undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      setLabel("");
      setApiKey("");
      setBaseUrl("");
    },
    onError: (err) => setError((err as Error).message),
  });

  const scanModels = useMutation({
    mutationFn: (id: string) => api.post<{ models: ModelInfo[] }>(`/providers/${id}/scan`),
    onSuccess: (res, id) => setScanResults((prev) => ({ ...prev, [id]: res.models })),
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    createProvider.mutate();
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-sm font-semibold text-fg-muted">Providers</h1>

      <ul className="mb-6 divide-y divide-border rounded border border-border">
        {data?.providers.map((p) => (
          <li key={p.id} className="px-3 py-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium">{p.label}</span>
                <span className="ml-2 font-mono text-xs text-fg-muted">
                  {p.provider} · {p.keyHint}
                </span>
              </div>
              <button
                onClick={() => scanModels.mutate(p.id)}
                disabled={scanModels.isPending}
                className="rounded border border-border px-2 py-1 text-xs text-fg-muted hover:text-fg"
              >
                Scan models
              </button>
            </div>
            {scanResults[p.id] && (
              <ul className="mt-2 flex flex-wrap gap-1">
                {scanResults[p.id]!.map((m) => (
                  <li key={m.id} className="rounded bg-bg-sunken px-1.5 py-0.5 font-mono text-xs text-fg-muted">
                    {m.id}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {data?.providers.length === 0 && (
          <li className="px-3 py-2 text-sm text-fg-muted">No providers configured yet.</li>
        )}
      </ul>

      <form onSubmit={onSubmit} className="rounded border border-border bg-bg-raised p-4">
        <h2 className="mb-3 text-xs font-semibold text-fg-muted">Add provider</h2>
        <div className="mb-2 flex gap-2">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
            className="rounded border border-border bg-bg px-2 py-1.5 text-sm"
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            placeholder="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="flex-1 rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
        </div>
        <input
          type="password"
          placeholder="API key"
          required
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="mb-2 w-full rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
        {provider === "openai-compatible" && (
          <input
            placeholder="Base URL, e.g. http://localhost:11434/v1"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="mb-2 w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
          />
        )}
        {error && <p className="mb-2 text-xs text-danger">{error}</p>}
        <button
          type="submit"
          disabled={createProvider.isPending}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {createProvider.isPending ? "Saving…" : "Add provider"}
        </button>
      </form>
    </div>
  );
}
