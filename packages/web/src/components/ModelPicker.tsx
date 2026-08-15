import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { api } from "../lib/api";
import type { ModelInfo } from "../lib/types";
import { Input } from "./ui";

export function ModelPicker({
  providerConfigId,
  value,
  onChange,
}: {
  providerConfigId: string;
  value: string;
  onChange: (modelId: string) => void;
}) {
  const [query, setQuery] = useState("");

  const modelsQuery = useQuery({
    queryKey: ["provider-models", providerConfigId],
    queryFn: () => api.post<{ models: ModelInfo[] }>(`/providers/${providerConfigId}/scan`),
    enabled: !!providerConfigId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const filtered = useMemo(() => {
    const models = modelsQuery.data?.models ?? [];
    const q = query.trim().toLowerCase();
    return q ? models.filter((m) => m.id.toLowerCase().includes(q)) : models;
  }, [modelsQuery.data, query]);

  if (!providerConfigId) {
    return <p className="text-xs text-fg-subtle">Select a provider first.</p>;
  }
  if (modelsQuery.isLoading) {
    return <p className="text-xs text-fg-muted">Scanning available models…</p>;
  }
  if (modelsQuery.isError) {
    return <p className="text-xs text-danger">{(modelsQuery.error as Error).message}</p>;
  }
  if (filtered.length === 0 && !query) {
    return <p className="text-xs text-fg-subtle">No models returned by this provider.</p>;
  }

  return (
    <div>
      {(modelsQuery.data?.models.length ?? 0) > 8 && (
        <div className="relative mb-2">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input
            placeholder="Filter models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      )}
      <div className="max-h-56 overflow-y-auto rounded-md border border-border">
        {filtered.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            className={`mono flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs ${
              value === m.id ? "bg-accent-wash text-accent" : "text-fg hover:bg-bg-hover"
            }`}
          >
            <span className="truncate">{m.id}</span>
            {value === m.id && <Check size={12} className="flex-shrink-0" />}
          </button>
        ))}
        {filtered.length === 0 && <p className="px-2.5 py-2 text-xs text-fg-subtle">No matches.</p>}
      </div>
    </div>
  );
}
