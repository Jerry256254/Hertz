import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type { ProviderConfig } from "../lib/types";

const inputCls =
  "h-11 w-full rounded-full border border-border bg-bg-sunken px-4 text-[14px] text-fg outline-none focus:border-accent";

/**
 * Shared "add a provider" form. Used by the first-run wizard and by
 * Settings → Poskytovatelé so both collect the same fields.
 */
export function ProviderCreateForm({
  onCreated,
  onCancel,
  submitLabel = "Přidat poskytovatele",
}: {
  onCreated: (id: string, defaultModel?: string) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<ProviderConfig["provider"]>("anthropic");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/providers", {
        provider,
        label: label.trim(),
        apiKey,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
      }),
    onSuccess: (res) => {
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      onCreated(res.id, defaultModel.trim() || undefined);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Přidání selhalo"),
  });

  return (
    <div className="space-y-2.5">
      <select
        value={provider}
        onChange={(e) => setProvider(e.target.value as ProviderConfig["provider"])}
        className={inputCls}
      >
        <option value="anthropic">Anthropic</option>
        <option value="openai">OpenAI</option>
        <option value="google">Google</option>
        <option value="openai-compatible">OpenAI-kompatibilní (vlastní URL)</option>
      </select>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Název, např. Můj Anthropic"
        className={inputCls}
      />
      <input
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        type="password"
        placeholder="API klíč"
        className={inputCls}
      />
      {provider === "openai-compatible" && (
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="Base URL"
          className={inputCls}
        />
      )}
      <input
        value={defaultModel}
        onChange={(e) => setDefaultModel(e.target.value)}
        placeholder="Výchozí model (nepovinné)"
        className={`${inputCls} mono`}
      />
      {err && <p className="text-[13px] text-danger">{err}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => create.mutate()}
          disabled={create.isPending || !label.trim()}
          className="pressable flex-1 rounded-full bg-accent py-2.5 text-[13.5px] font-[600] text-white disabled:opacity-40"
        >
          {create.isPending ? "Přidávám…" : submitLabel}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="pressable rounded-full border border-border bg-bg-sunken px-5 py-2.5 text-[13.5px] font-[600] text-fg"
          >
            Zrušit
          </button>
        )}
      </div>
    </div>
  );
}
