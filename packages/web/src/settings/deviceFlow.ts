/**
 * OAuth 2.0 Device flow pro Google — čistá logika bez Reactu.
 * Transport (HTTP volání) se předává zvenčí, takže jde celý flow
 * otestovat s mock fetch bez prohlížeče.
 *
 * Serverový kontrakt (paralelní etapa):
 *   POST /api/oauth/google/device/start
 *     → { user_code, verification_url, expires_in, device_session_id }
 *   GET  /api/oauth/google/device/status?session=<id>
 *     → { status: "pending"|"connected"|"denied"|"expired"|"error", message? }
 */

export interface DeviceStartResponse {
  user_code: string;
  verification_url: string;
  /** Za kolik sekund kód vyprší. */
  expires_in: number;
  device_session_id: string;
}

export type DeviceStatus = "pending" | "connected" | "denied" | "expired" | "error";

export interface DeviceStatusResponse {
  status: DeviceStatus;
  /** Lidská česká hláška od serveru (hlavně pro "error"). */
  message?: string;
}

/** Stav, ve kterém už polling končí (cokoliv kromě "pending"). */
export type DeviceTerminalStatus = Exclude<DeviceStatus, "pending">;

export interface DeviceTerminalStatusResponse {
  status: DeviceTerminalStatus;
  message?: string;
}

/** Minimální HTTP transport — v aplikaci se napojí na `api` z lib/api. */
export interface DeviceFlowTransport {
  postJson<T>(path: string): Promise<T>;
  getJson<T>(path: string): Promise<T>;
}

/** Interval pollingu statusu (ms). */
export const DEVICE_POLL_INTERVAL_MS = 3000;

/** Začne device flow: vrátí kód a adresu k potvrzení. */
export async function startDeviceFlow(t: DeviceFlowTransport): Promise<DeviceStartResponse> {
  return t.postJson<DeviceStartResponse>("/oauth/google/device/start");
}

/** Jeden dotaz na stav device session. */
export async function fetchDeviceStatus(t: DeviceFlowTransport, sessionId: string): Promise<DeviceStatusResponse> {
  return t.getJson<DeviceStatusResponse>(`/oauth/google/device/status?session=${encodeURIComponent(sessionId)}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Přerušeno", "AbortError"));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(id);
      reject(new DOMException("Přerušeno", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polluje stav, dokud není terminální (cokoliv jiného než "pending").
 * Každý mezistav hlásí přes onStatus. Přerušení přes AbortSignal.
 */
export async function pollDeviceStatus(
  t: DeviceFlowTransport,
  sessionId: string,
  opts: {
    intervalMs?: number;
    signal?: AbortSignal;
    onStatus?: (s: DeviceStatusResponse) => void;
  } = {},
): Promise<DeviceTerminalStatusResponse> {
  const intervalMs = opts.intervalMs ?? DEVICE_POLL_INTERVAL_MS;
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException("Přerušeno", "AbortError");
    const res = await fetchDeviceStatus(t, sessionId);
    opts.onStatus?.(res);
    // Smyčka končí jen na terminálním stavu — "pending" se tu už nevrátí.
    if (res.status !== "pending") return res as DeviceTerminalStatusResponse;
    await sleep(intervalMs, opts.signal);
  }
}

/** Lidská česká hláška pro terminální stav. Bez emoji. */
export function deviceStatusText(status: DeviceStatus, serverMessage?: string): string {
  switch (status) {
    case "connected":
      return "Připojeno — Google je teď napojený na agenta.";
    case "denied":
      return "Na stránce Googlu jsi přihlášení zamítl(a). Nic se nestalo — můžeš to zkusit znovu.";
    case "expired":
      return "Kód vypršel, aniž bys ho potvrdil(a). Klikni na „Zkusit znovu“ a připravím nový.";
    case "error":
      return serverMessage?.trim() || "Něco se na straně Googlu pokazilo. Zkus to prosím znovu.";
    case "pending":
      return "Čekám, až kód potvrdíš na stránce Googlu…";
  }
}
