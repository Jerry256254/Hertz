import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type { ProviderConfig } from "../lib/types";
import { CopyButton } from "./CopyButton";

const inputCls =
  "h-11 w-full rounded-full border border-border bg-bg-sunken px-4 text-[14px] text-fg outline-none focus:border-accent";

const GOOGLE_AI_STUDIO_URL = "https://aistudio.google.com";
/**
 * Rozumný výchozí model pro Google: rychlý, levný, umí generateContent
 * i function calling. Model je v ceníku packages/providers/src/pricing/google.json,
 * takže je podporovaný i výpočtem cen.
 */
const GOOGLE_DEFAULT_MODEL = "gemini-2.5-flash";

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

  function selectProvider(v: ProviderConfig["provider"]) {
    setProvider(v);
    // U Google uživatel vkládá API klíč z AI Studia (ne OAuth) — předvyplníme
    // rozumné výchozí hodnoty, aby nemusel nic luštit.
    if (v === "google") {
      if (!label.trim()) setLabel("Gemini");
      if (!defaultModel.trim()) setDefaultModel(GOOGLE_DEFAULT_MODEL);
    }
  }

  function reset() {
    setLabel("");
    setProvider("openai-compatible");
    setApiKey("");
    setBaseUrl("");
    setDefaultModel("");
  }

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
      const model = defaultModel.trim() || undefined;
      reset();
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      onCreated(res.id, model);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "Přidání selhalo"),
  });

  // label + API klíč jsou povinné (Anthropic má OAuth, takže klíč skrytý a
  // volitelný); u openai-compatible navíc URL serveru. U Google vyžadujeme
  // i výchozí model — server žádný nedoplňuje a bez modelu chat neběží
  // (tlačítko se po přechodu na Google předvyplní na gemini-2.5-flash).
  const canSubmit =
    !create.isPending &&
    label.trim().length > 0 &&
    (provider === "anthropic" || apiKey.trim().length > 0) &&
    (provider !== "openai-compatible" || baseUrl.trim().length > 0) &&
    (provider !== "google" || defaultModel.trim().length > 0);

  return (
    <div className="space-y-2.5">
      <select
        value={provider}
        onChange={(e) => selectProvider(e.target.value as ProviderConfig["provider"])}
        className={inputCls}
      >
        <option value="anthropic">Anthropic</option>
        <option value="openai">OpenAI</option>
        <option value="google">Google</option>
        <option value="openai-compatible">OpenAI-kompatibilní (vlastní URL)</option>
      </select>
      {provider === "google" && (
        <div className="rounded-[14px] border border-accent/30 bg-accent-wash px-4 py-3">
          <p className="text-[13px] font-[700] text-fg">Vlož API klíč z Google AI Studia</p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-fg-muted">
            <li>
              Otevři <span className="mono">aistudio.google.com</span> a přihlas se svým účtem Google.
            </li>
            <li>Klikni na „Get API key" a pak na „Create API key".</li>
            <li>Klíč zkopíruj a vlož ho do pole „API klíč" níže.</li>
          </ol>
          <div className="mt-2.5 flex items-center gap-2">
            <a
              href={GOOGLE_AI_STUDIO_URL}
              target="_blank"
              rel="noreferrer"
              className="mono min-w-0 flex-1 truncate text-[12.5px] text-accent underline underline-offset-2"
            >
              {GOOGLE_AI_STUDIO_URL}
            </a>
            <CopyButton value={GOOGLE_AI_STUDIO_URL} ariaLabel="Zkopírovat adresu Google AI Studia" />
          </div>
        </div>
      )}
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
        placeholder={
          provider === "google" ? "Výchozí model (např. gemini-2.5-flash)" : "Výchozí model (nepovinné)"
        }
        className={`${inputCls} mono`}
      />
      {provider === "google" && !defaultModel.trim() && (
        <p className="px-1 text-[12.5px] leading-snug text-fg-muted">
          Zadej výchozí model — bez něj agent neví, který model Gemini použít (např. gemini-2.5-flash).
        </p>
      )}
      {err && <p className="text-[13px] text-danger">{err}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => create.mutate()}
          disabled={!canSubmit}
          className="pressable flex-1 rounded-full bg-accent py-2.5 text-[13.5px] font-[600] text-white disabled:opacity-40"
        >
          {create.isPending ? "Přidávám…" : submitLabel}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="pressable min-h-[44px] rounded-full border border-border bg-bg-sunken px-5 py-2.5 text-[13.5px] font-[600] text-fg"
          >
            Zrušit
          </button>
        )}
      </div>
    </div>
  );
}
