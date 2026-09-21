import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, Search, TriangleAlert } from "lucide-react";
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

  const queryClient = useQueryClient();
  const modelsQuery = useQuery({
    queryKey: ["provider-models", providerConfigId],
    queryFn: () => api.post<{ models: ModelInfo[] }>(`/providers/${providerConfigId}/scan`),
    enabled: !!providerConfigId,
    staleTime: 60_000,
    retry: false,
  });

  const scanned = useMemo(() => {
    return (modelsQuery.data?.models ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
  }, [modelsQuery.data]);

  // The stored value may be stale (renamed/retired by the provider, or typed
  // by hand) — surface it loudly instead of letting the run die at stream time.
  const currentMissing =
    !!value &&
    !modelsQuery.isLoading &&
    !modelsQuery.isError &&
    scanned.length > 0 &&
    !scanned.some((m) => m.id === value);

  const filtered = useMemo(() => {
    const models = scanned.slice();
    // The current value never disappears — even when the scan lags behind it.
    if (value && !models.some((m) => m.id === value)) {
      models.unshift({ id: value, displayName: `${value} (aktuální)` });
    }
    const q = query.trim().toLowerCase();
    return q ? models.filter((m) => m.id.toLowerCase().includes(q)) : models;
  }, [scanned, query, value]);

  if (!providerConfigId) {
    return <p className="text-xs text-fg-subtle">Nejdřív vyber poskytovatele.</p>;
  }
  if (modelsQuery.isLoading) {
    return <p className="text-xs text-fg-muted">Načítám dostupné modely…</p>;
  }
  if (modelsQuery.isError) {
    return <p className="text-xs text-danger">{(modelsQuery.error as Error).message}</p>;
  }
  if (filtered.length === 0 && !query) {
    return <p className="text-xs text-fg-subtle">Poskytovatel nevrátil žádné modely.</p>;
  }

  return (
    <div>
      {currentMissing && (
        <div className="mb-2 flex items-start gap-2 rounded-[12px] border border-warning/30 bg-warning-wash px-3 py-2">
          <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warning" />
          <p className="text-[12px] leading-snug text-fg">
            Model <span className="mono font-[600]">{value}</span> provider aktuálně nenabízí — s ním chat selže.
            Vyber jiný ze seznamu níže.
          </p>
        </div>
      )}
      <div className="mb-2 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <Input
            placeholder="Filtrovat modely…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-7 text-xs"
          />
        </div>
        <button
          type="button"
          title="Znovu načíst modely od providera"
          disabled={modelsQuery.isFetching}
          onClick={() => void queryClient.invalidateQueries({ queryKey: ["provider-models", providerConfigId] })}
          className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-bg-sunken text-fg-muted hover:text-fg disabled:opacity-40"
        >
          <RefreshCw size={13} className={modelsQuery.isFetching ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto rounded-md border border-border">
        {filtered.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            className={`mono flex min-h-[44px] w-full items-center justify-between px-2.5 py-1.5 text-left text-xs ${
              value === m.id ? "bg-accent-wash text-accent" : "text-fg hover:bg-bg-hover"
            }`}
          >
            <span className="truncate">{m.id}</span>
            {value === m.id && <Check size={12} className="flex-shrink-0" />}
          </button>
        ))}
        {filtered.length === 0 && <p className="px-2.5 py-2 text-xs text-fg-subtle">Žádné shody.</p>}
      </div>
    </div>
  );
}
