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
  const { data: providersData } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get<{ providers: ProviderConfig[] }>("/providers"),
  });
  const providers = providersData?.providers ?? [];

  function pickProvider(id: string) {
    onProviderIdChange(id);
    const p = providers.find((x) => x.id === id);
    if (p?.defaultModel) onModelChange(p.defaultModel);
  }

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">POSKYTOVATEL</p>
      <select
        id={`${idPrefix}-provider`}
        value={providerId}
        onChange={(e) => pickProvider(e.target.value)}
        className="h-10 w-full rounded-[12px] border border-border bg-bg-sunken px-3 text-[13px] text-fg outline-none focus:border-accent"
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} ({p.provider})
          </option>
        ))}
      </select>
      <p className="mb-1.5 mt-3 text-[11px] font-[700] tracking-[0.06em] text-fg-subtle">MODEL</p>
      <ModelPicker providerConfigId={providerId} value={model} onChange={onModelChange} />
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
