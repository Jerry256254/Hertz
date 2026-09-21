import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ProviderConfig } from "../lib/types";
import { ModelPicker } from "./ModelPicker";

/**
 * Shared provider + model editor: provider select, scanned model list and a
 * manual model-id fallback. Used by the agent panel and by Settings → Obecné
 * so both edit the same thing the same way.
 */
export function ModelFields({
  providerId,
  onProviderIdChange,
  model,
  onModelChange,
  idPrefix = "model",
}: {
  providerId: string;
  onProviderIdChange: (id: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  idPrefix?: string;
}) {
  const { data: providersData, isLoading: providersLoading } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });
  const providers = providersData?.providers ?? [];

  function pickProvider(id: string) {
    onProviderIdChange(id);
    const p = providers.find((x) => x.id === id);
    // A provider without a default model must NOT silently keep the previous
    // provider's model (the run would fail) — clear it and force a pick.
    onModelChange(p?.defaultModel ?? "");
  }

  if (providersLoading) {
    return <p className="py-2 text-[12.5px] text-fg-muted">Načítám poskytovatele…</p>;
  }
  if (providers.length === 0) {
    return (
      <p className="py-2 text-[12.5px] leading-relaxed text-fg-muted">
        Zatím žádný poskytovatel. Přidej ho v Nastavení › Poskytovatelé.
      </p>
    );
  }

  const known = providers.some((p) => p.id === providerId);

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">POSKYTOVATEL</p>
      <select
        id={`${idPrefix}-provider`}
        value={known ? providerId : ""}
        onChange={(e) => pickProvider(e.target.value)}
        className="h-10 w-full rounded-[12px] border border-border bg-bg-sunken px-3 text-[13px] text-fg outline-none focus:border-accent"
      >
        {!known && (
          <option value="" disabled>
            {providerId ? "Poskytovatel už neexistuje — vyber jiného" : "Vyber poskytovatele"}
          </option>
        )}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} ({p.provider})
          </option>
        ))}
      </select>
      <p className="mb-1.5 mt-3 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">MODEL</p>
      <ModelPicker providerConfigId={known ? providerId : ""} value={model} onChange={onModelChange} />
      {!model.trim() && (
        <p className="mt-2 rounded-[12px] border border-warning/30 bg-warning-wash px-3 py-2 text-[12px] leading-snug text-fg">
          Bez modelu chat neběží — vyber ho ze seznamu, nebo napiš ID ručně.
        </p>
      )}
      <input
        id={`${idPrefix}-manual`}
        value={model}
        onChange={(e) => onModelChange(e.target.value)}
        placeholder="…nebo napiš ID modelu ručně"
        className="mono mt-2 h-10 w-full rounded-[12px] border border-border bg-bg-sunken px-3 text-[12.5px] text-fg outline-none focus:border-accent"
      />
    </div>
  );
}
