import { useCallback, useEffect, useRef, useState } from "react";
import { CopyButton } from "../components/CopyButton";
import { api, ApiError } from "../lib/api";
import {
  DEVICE_POLL_INTERVAL_MS,
  deviceStatusText,
  pollDeviceStatus,
  startDeviceFlow,
  type DeviceStartResponse,
  type DeviceTerminalStatus,
  type DeviceFlowTransport,
} from "./deviceFlow";

const transport: DeviceFlowTransport = {
  postJson: (path) => api.post(path),
  getJson: (path) => api.get(path),
};

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; start: DeviceStartResponse }
  | { kind: "connected" }
  | { kind: "startError"; message: string }
  | { kind: "failed"; status: Exclude<DeviceTerminalStatus, "connected">; message: string | null };

/** Z textu udělá klikací odkazy (server může v hlášce poslat URL návodu). */
function linkify(text: string): React.ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noreferrer" className="font-[600] text-accent underline">
        {p}
      </a>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

/**
 * Primární cesta připojení Googlu: „Připojit kódem“ (OAuth 2.0 Device flow).
 * Kliknutí → start endpoint → karta s velkým kódem → polling statusu na pozadí.
 * Web/relay cesta zůstává jako sekundární odkaz pod kartou.
 */
export function GoogleDeviceFlow({
  relayUrl,
  onConnected,
  onClose,
}: {
  /** Stávající web/relay přihlášení — sekundární možnost. */
  relayUrl: string;
  /** Zavolá se po úspěšném připojení (obnovení seznamu konektorů). */
  onConnected: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [starting, setStarting] = useState(false);
  const runId = useRef(0);
  const ctrlRef = useRef<AbortController | null>(null);

  const begin = useCallback(
    async (ctrl: AbortController) => {
      const id = ++runId.current;
      setStarting(true);
      setPhase({ kind: "starting" });
      let start: DeviceStartResponse;
      try {
        start = await startDeviceFlow(transport);
      } catch (e) {
        if (runId.current !== id) return;
        // Server vrací lidské české vysvětlení (vč. chybějících TV credentials
        // a odkazu na návod) — zobrazíme ho tak, jak je, bez technického erroru.
        const message = e instanceof ApiError ? e.message : "Nepodařilo se připravit kód. Zkus to prosím znovu.";
        setStarting(false);
        setPhase({ kind: "startError", message });
        return;
      }
      if (runId.current !== id || ctrl.signal.aborted) return;
      setStarting(false);
      setPhase({ kind: "waiting", start });
      try {
        const final = await pollDeviceStatus(transport, start.device_session_id, {
          intervalMs: DEVICE_POLL_INTERVAL_MS,
          signal: ctrl.signal,
        });
        if (runId.current !== id) return;
        if (final.status === "connected") {
          setPhase({ kind: "connected" });
          onConnected();
        } else {
          setPhase({ kind: "failed", status: final.status, message: final.message ?? null });
        }
      } catch (e) {
        // Přerušeno odmountováním / restartem — ticho, nic nezobrazovat.
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (runId.current !== id) return;
        setPhase({ kind: "startError", message: "Spojení se serverem selhalo. Zkus to prosím znovu." });
      }
    },
    [onConnected],
  );

  /** Spustí (nebo restartuje) flow; předchozí polling se přeruší. */
  const runFlow = useCallback(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    void begin(ctrl);
  }, [begin]);

  useEffect(() => {
    runFlow();
    return () => {
      // Cleanup při odmountování: zruší probíhající polling.
      ctrlRef.current?.abort();
      runId.current++;
    };
  }, [runFlow]);

  const retry = () => {
    if (starting) return;
    runFlow();
  };

  const expiresMinutes = Math.max(1, Math.round((phase.kind === "waiting" ? phase.start.expires_in : 0) / 60));

  return (
    <div className="rounded-[12px] border border-border bg-bg px-4 py-4">
      {phase.kind === "starting" && (
        <p className="text-[13px] text-fg-muted" aria-live="polite">
          Připravuji kód…
        </p>
      )}

      {phase.kind === "startError" && (
        <div>
          <p className="text-[13px] font-[600] text-fg">Kód se nepodařilo připravit</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">{linkify(phase.message)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={retry}
              className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 text-[13px] font-[600] text-white"
            >
              Zkusit znovu
            </button>
            <button
              onClick={onClose}
              className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 text-[13px] font-[600] text-fg"
            >
              Zavřít
            </button>
          </div>
        </div>
      )}

      {phase.kind === "waiting" && (
        <div>
          <p className="text-[13px] font-[600] text-fg">Připojit Google kódem</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-fg-muted">
            <li>
              Otevři stránku Googlu:{" "}
              <span className="mono break-all text-[12.5px] text-fg">{phase.start.verification_url}</span>
            </li>
            <li>Zadej tam tento kód a přihlášení potvrď.</li>
          </ol>
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[12px] border border-border bg-bg-sunken px-4 py-3">
            <p
              className="mono flex-1 text-center text-[30px] font-[800] tracking-[0.18em] text-fg"
              aria-label={`Kód k zadání: ${phase.start.user_code}`}
            >
              {phase.start.user_code}
            </p>
            <CopyButton value={phase.start.user_code} ariaLabel="Zkopírovat kód" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="mono min-w-0 flex-1 break-all text-[12px] text-fg-subtle">{phase.start.verification_url}</p>
            <CopyButton value={phase.start.verification_url} ariaLabel="Zkopírovat adresu stránky" />
          </div>
          <p className="mt-3 text-[12.5px] text-fg-muted" aria-live="polite">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent align-middle" aria-hidden="true" />{" "}
            {deviceStatusText("pending")} Kód platí ještě asi {expiresMinutes} min.
          </p>
          <div className="mt-3">
            <button
              onClick={onClose}
              className="pressable inline-flex min-h-[40px] items-center justify-center rounded-full border border-border bg-bg-sunken px-4 text-[12.5px] font-[600] text-fg"
            >
              Zrušit
            </button>
          </div>
        </div>
      )}

      {phase.kind === "connected" && (
        <div>
          <p className="text-[13px] font-[700] text-live">Připojeno</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">{deviceStatusText("connected")}</p>
          <button
            onClick={onClose}
            className="pressable mt-3 inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 text-[13px] font-[600] text-fg"
          >
            Zavřít
          </button>
        </div>
      )}

      {phase.kind === "failed" && (
        <div>
          <p className="text-[13px] font-[600] text-fg">Připojení se nezdařilo</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">
            {linkify(deviceStatusText(phase.status, phase.message ?? undefined))}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={retry}
              className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 text-[13px] font-[600] text-white"
            >
              Zkusit znovu
            </button>
            <button
              onClick={onClose}
              className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 text-[13px] font-[600] text-fg"
            >
              Zavřít
            </button>
          </div>
        </div>
      )}

      {/* Sekundární cesta: stávající přihlášení přes prohlížeč (web/relay). */}
      <p className="mt-4 border-t border-border pt-3 text-[12.5px] text-fg-subtle">
        Jiná možnost:{" "}
        <a href={relayUrl} className="font-[600] text-accent underline">
          přihlášení přes prohlížeč
        </a>
      </p>
    </div>
  );
}
