import { useEffect, useRef, useState } from "react";
import { CopyButton } from "../components/CopyButton";
import { api } from "../lib/api";
import {
  DeviceFlowSession,
  deviceStartAction,
  deviceStatusText,
  type DeviceFlowPhase,
  type DeviceFlowTransport,
  type DeviceStartErrorInfo,
} from "./deviceFlow";

const transport: DeviceFlowTransport = {
  postJson: (path) => api.post(path),
  getJson: (path) => api.get(path),
};

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
 * Chybová karta startu (i selhání po startu): zobrazí český text ze serveru,
 * případný odkaz na návod a správnou primární akci — opakování, nebo vložení
 * údajů klienta. Generická „zkus to za chvíli“ se neukazuje tam, kde známe
 * příčinu (chybějící/neplatné údaje TV klienta).
 */
function StartErrorCard({
  error,
  onRetry,
  onEnterCredentials,
  onClose,
}: {
  error: DeviceStartErrorInfo;
  onRetry: () => void;
  onEnterCredentials: () => void;
  onClose: () => void;
}) {
  const action = deviceStartAction(error);
  const showGuide = !!error.guideUrl && !error.message.includes(error.guideUrl);
  return (
    <div>
      <p className="text-[13px] font-[600] text-fg">
        {action === "enter_credentials" ? "Nejdřív vlož údaje klienta" : "Kód se nepodařilo připravit"}
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">{linkify(error.message)}</p>
      {showGuide && (
        <p className="mt-1.5 text-[12.5px]">
          <a href={error.guideUrl} target="_blank" rel="noreferrer" className="font-[600] text-accent underline">
            Otevřít návod k nastavení
          </a>
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {action === "enter_credentials" ? (
          <button
            onClick={onEnterCredentials}
            className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 text-[13px] font-[600] text-white"
          >
            Vložit údaje
          </button>
        ) : (
          <button
            onClick={onRetry}
            className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full bg-accent px-5 text-[13px] font-[600] text-white"
          >
            Zkusit znovu
          </button>
        )}
        <button
          onClick={onClose}
          className="pressable inline-flex min-h-[44px] items-center justify-center rounded-full border border-border bg-bg-sunken px-5 text-[13px] font-[600] text-fg"
        >
          Zavřít
        </button>
      </div>
    </div>
  );
}

/**
 * Primární cesta připojení Googlu: „Připojit kódem“ (OAuth 2.0 Device flow).
 * Mount → start endpoint → karta s velkým kódem → polling statusu na pozadí.
 * Opakování jen explicitně tlačítkem „Zkusit znovu" (žádný restart při
 * re-renderu rodiče).
 * Web/relay cesta zůstává jako sekundární odkaz pod kartou.
 */
export function GoogleDeviceFlow({
  relayUrl,
  onConnected,
  onClose,
  onEnterCredentials,
}: {
  /** Stávající web/relay přihlášení — sekundární možnost. */
  relayUrl: string;
  /** Zavolá se po úspěšném připojení (obnovení seznamu konektorů). */
  onConnected: () => void;
  onClose: () => void;
  /** Otevře formulář pro vložení údajů TV klienta (při chybě údajů). */
  onEnterCredentials: () => void;
}) {
  const [phase, setPhase] = useState<DeviceFlowPhase>({ kind: "starting" });

  // onConnected má při každém renderu rodiče novou identitu (obyčejná funkce
  // v těle komponenty) — držet ho v refu, aby se session nemusela nikdy
  // znovu vytvářet a flow se nerestartoval při každém re-renderu rodiče
  // (refetch invalidovaných queries, window-focus refetch, …).
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // Session žije po celou dobu mountu: vytvoří se jednou, effect níže ji
  // jednou spustí. Restart je možný jen explicitně („Zkusit znovu").
  const [session] = useState(
    () =>
      new DeviceFlowSession(transport, {
        onPhase: (p) => setPhase(p),
        onConnected: () => onConnectedRef.current(),
      }),
  );

  useEffect(() => {
    session.start();
    return () => {
      // Cleanup při odmountování: zruší probíhající polling.
      session.destroy();
    };
  }, [session]);

  const starting = phase.kind === "starting";
  const retry = () => {
    if (starting) return;
    session.start();
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
        <StartErrorCard
          error={phase.error}
          onRetry={retry}
          onEnterCredentials={onEnterCredentials}
          onClose={onClose}
        />
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

      {phase.kind === "failed" && phase.status === "error" && (
        <StartErrorCard
          error={{ code: phase.code, message: phase.message?.trim() || deviceStatusText("error"), guideUrl: phase.guideUrl }}
          onRetry={retry}
          onEnterCredentials={onEnterCredentials}
          onClose={onClose}
        />
      )}

      {phase.kind === "failed" && phase.status !== "error" && (
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
