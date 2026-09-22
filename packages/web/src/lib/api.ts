/** Akce, kterou má UI nabídnout po chybě endpointu. */
export type ApiErrorAction = "enter_credentials" | "retry";

export class ApiError extends Error {
  public status: number;
  /** Strojový kód chyby ze serveru (např. "missing_client_id"), pokud ho poslal. */
  public readonly code?: string;
  /** Odkaz na návod k nápravě, pokud ho server poslal. */
  public readonly guideUrl?: string;
  /** Akce doporučená serverem, pokud ji poslal. */
  public readonly action?: ApiErrorAction;
  constructor(status: number, message: string, details?: { code?: unknown; guideUrl?: unknown; action?: unknown }) {
    super(message);
    // Bez parameter properties — soubor se importuje i v node strip-only
    // režimu (testy), který je nepodporuje.
    this.status = status;
    if (typeof details?.code === "string" && details.code) this.code = details.code;
    if (typeof details?.guideUrl === "string" && details.guideUrl) this.guideUrl = details.guideUrl;
    if (details?.action === "enter_credentials" || details?.action === "retry") this.action = details.action;
  }
}

/**
 * Obrana v hloubce: server by už neměl posílat surový Zod JSON v `error`,
 * ale kdyby se nějaký dostal až ke klientovi (stará verze serveru, proxy,
 * …), nahradíme ho českou obecnou hláškou. Surový JSON se nikdy nesmí
 * dostat do DOM.
 */
export function sanitizeErrorMessage(message: string): string {
  const m = message.trim();
  const looksLikeZodJson =
    (m.startsWith("[") && m.endsWith("]") && m.includes('"code"')) ||
    m.includes('"code":"too_small"') ||
    m.includes('"path":[');
  if (looksLikeZodJson) return "Zadané údaje nejsou v pořádku, zkontroluj je prosím.";
  return message;
}

let unauthorizedHandler: (() => void) | null = null;
let unauthorizedFired = false;

/**
 * Registers a one-shot-per-page-load callback for 401 responses (expired
 * session). Auth endpoints themselves are excluded so the login flow and
 * the initial "am I logged in" probe never trigger it.
 */
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn;
}

/** API paths that legitimately return 401 without meaning "session expired". */
const AUTH_PATHS = ["/auth/", "/setup/"];

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 401 && !unauthorizedFired && !AUTH_PATHS.some((p) => path.startsWith(p))) {
      unauthorizedFired = true;
      try {
        unauthorizedHandler?.();
      } catch {
        /* handler must never break the request path */
      }
    }
    let message = res.statusText;
    let code: unknown;
    let guideUrl: unknown;
    let action: unknown;
    try {
      const data = await res.json();
      if (data && typeof data === "object") {
        // Server posílá český text v `error`; `message` akceptujeme pro
        // kompatibilitu s novým strukturovaným kontraktem chyb.
        if (typeof data.error === "string" && data.error) message = data.error;
        else if (typeof data.message === "string" && data.message) message = data.message;
        code = data.code ?? data.error_code;
        guideUrl = data.guideUrl ?? data.guide_url;
        action = data.action;
      }
    } catch {
      // ignore
    }
    throw new ApiError(res.status, sanitizeErrorMessage(message), { code, guideUrl, action });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
