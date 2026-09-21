/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) pro Google.
 *
 * Primární cesta „click to play" pro připojení Google na instancích, kde
 * nefunguje web redirect (privátní IP): žádná redirect URI, žádný veřejný
 * endpoint. Server získá device_code + user_code, uživatel zadá kód na
 * https://www.google.com/device a server na pozadí polluje token endpoint,
 * dokud uživatel souhlas neudělí (nebo kód nevyprší).
 *
 * Požadavek na https://oauth2.googleapis.com/device/code je podle Google
 * docs form-urlencoded `client_id` + `scope` — žádný client_secret se
 * neposílá (používá se až při pollingu token endpointu, a jen když je
 * nakonfigurovaný). TV klient secret ignoruje/nevyžaduje.
 *
 * BEZPEČNOST: nikde se neloguje client_secret, device_code ani tokeny —
 * ani v error objektech. Chybové popisy od Googlu (`error_description`)
 * se zalogují na serveru vždy až po redakci citlivých hodnot.
 * Všechny zprávy pro uživatele jsou česky.
 */
import { googleTokenUrl } from "./oauth-service.js";

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  /** Platnost kódu v sekundách (z `expires_in`). */
  expiresIn: number;
  /** Minimální prodleva mezi pokusy v sekundách (z `interval`). */
  interval: number;
}

export type DeviceFlowErrorCode =
  | "missing_client_id"
  | "invalid_client_type"
  | "access_denied"
  | "expired_token"
  | "provider_error"
  | "network_error"
  /** Nečitelné tělo požadavku (chyba parsování na API) — tvar odpovědi, nikdy výjimka. */
  | "bad_request"
  /** Relace device flow neexistuje — tvar odpovědi, nikdy výjimka. */
  | "session_not_found";

/**
 * Kódy chyb, které znamenají špatnou konfiguraci OAuth klienta — frontend
 * k nim smí zobrazit odkaz na návod (guideUrl).
 */
export const DEVICE_FLOW_GUIDED_ERRORS: DeviceFlowErrorCode[] = ["missing_client_id", "invalid_client_type"];

/**
 * Kam poslat správce serveru, když device flow selže na konfiguraci OAuth
 * klienta (vytvoření TV klienta, zapnutí API). Odpovídá setupUrl v katalogu.
 */
export const GOOGLE_DEVICE_CLIENT_GUIDE_URL = "https://console.cloud.google.com/apis/credentials";

/** Logger pro serverovou diagnostiku (volitelný — bez něj se nic neloguje). */
export type DeviceFlowLogger = (msg: string) => void;

export class DeviceFlowError extends Error {
  readonly code: DeviceFlowErrorCode;
  constructor(code: DeviceFlowErrorCode, message: string) {
    super(message);
    this.name = "DeviceFlowError";
    this.code = code;
  }
}

export interface DeviceTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export type FetchImpl = typeof fetch;

export type DeviceSessionStatus = "pending" | "connected" | "denied" | "expired" | "error";

/**
 * Endpoint pro device authorization — přepisovatelný přes env, aby šel celý
 * flow otestovat proti lokálnímu mock poskytovateli (stejný vzor jako
 * HERTZ_OAUTH_GOOGLE_TOKEN_URL v oauth-service.ts).
 */
export function googleDeviceCodeUrl(): string {
  return process.env.HERTZ_OAUTH_GOOGLE_DEVICE_CODE_URL ?? "https://oauth2.googleapis.com/device/code";
}

const DEFAULT_EXPIRES_IN_SEC = 600;
const DEFAULT_INTERVAL_SEC = 5;
const SLOW_DOWN_STEP_SEC = 5;

/** Vysvětlení pro případ, že Google odmítne přihlašovací údaj (špatný typ klienta). */
export const INVALID_CLIENT_TYPE_MESSAGE =
  "Google tento přihlašovací údaj odmítl — OAuth klient musí být typu „TVs and Limited Input devices“, ne typu „Web“. " +
  "Vytvoř v Google Cloud Console nového klienta správného typu a vlož jeho Client ID.";

/** Vymaže citlivé hodnoty z textu určeného do logu. */
function redactForLog(text: string, sensitive: string[]): string {
  let out = text;
  for (const s of sensitive) {
    if (s) out = out.split(s).join("[redacted]");
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Krok 1 device flow: požádá Google o device_code a user_code pro zadané
 * scope. Vrací kódy k zobrazení uživateli — device_code drží jen server.
 */
export async function requestDeviceCode(
  clientId: string,
  scopes: string[],
  opts?: { fetchImpl?: FetchImpl; log?: DeviceFlowLogger },
): Promise<DeviceAuthorizationResponse> {
  if (!clientId || !clientId.trim()) {
    throw new DeviceFlowError(
      "missing_client_id",
      "Nejdřív vlož Client ID TV klienta v Nastavení → Konektory (krok pro správce serveru).",
    );
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const log = opts?.log;
  let res: Response;
  try {
    res = await fetchImpl(googleDeviceCodeUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: scopes.join(" ") }),
    });
  } catch {
    throw new DeviceFlowError(
      "network_error",
      "Server se teď nedostal ke Googlu, zkus to prosím za chvíli znovu.",
    );
  }
  if (!res.ok) {
    let googleError = "";
    let googleDescription = "";
    try {
      const errBody: unknown = await res.json();
      if (isRecord(errBody)) {
        if (typeof errBody.error === "string") googleError = errBody.error;
        if (typeof errBody.error_description === "string") googleDescription = errBody.error_description;
      }
    } catch {
      // Nečitelná chybová odpověď — padne do default větve níže.
    }
    // error_description se zaloguje pro diagnostiku, ale až po redakci
    // citlivých hodnot (může obsahovat client_id).
    log?.(
      `[oauth-device] device/code odmítnuto: error=${googleError || "neznámá"} status=${res.status} ` +
        `popis=${redactForLog(googleDescription, [clientId])}`,
    );
    switch (googleError) {
      case "invalid_client":
      case "unauthorized_client":
        // Typicky klient typu „Web" místo „TVs and Limited Input devices" —
        // Google device flow pro web klienty odmítá.
        throw new DeviceFlowError("invalid_client_type", INVALID_CLIENT_TYPE_MESSAGE);
      default:
        throw new DeviceFlowError(
          "provider_error",
          "Google teď nevydal kód pro spárování — zkuste to prosím za chvíli znovu.",
        );
    }
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new DeviceFlowError("provider_error", "Google vrátil neplatnou odpověď — zkuste to prosím znovu.");
  }
  if (typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new DeviceFlowError("provider_error", "Google vrátil neplatnou odpověď — zkuste to prosím znovu.");
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl: typeof body.verification_url === "string" ? body.verification_url : "https://www.google.com/device",
    verificationUrlComplete:
      typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : undefined,
    expiresIn: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_SEC,
    interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : DEFAULT_INTERVAL_SEC,
  };
}

export interface PollDeviceTokenOptions {
  clientId: string;
  /** Posílá se jen když je nakonfigurovaný (Desktop klient). */
  clientSecret?: string;
  deviceCode: string;
  intervalSec: number;
  expiresInSec: number;
  /** Volá se po každém neúspěšném pokusu (pro progress v UI). */
  onPending?: (pollCount: number) => void;
  fetchImpl?: FetchImpl;
  /** Injektovatelné pro testy (jinak reálný časovač). */
  sleep?: (ms: number) => Promise<void>;
  /** Injektovatelné pro testy (jinak Date.now). */
  now?: () => number;
  /** Serverový log pro diagnostiku (error_description se loguje redakčně). */
  log?: DeviceFlowLogger;
}

/**
 * Krok 2 device flow: polluje token endpoint, dokud uživatel na zařízení
 * souhlas neudělí. Respektuje `interval` (prodleva před každým pokusem),
 * `slow_down` (interval +5 s) i `expires_in` (tvrdý konec). Chyby jsou
 * typované (DeviceFlowError) s českými zprávami; secret, device_code ani
 * tokeny se nikdy nedostanou do logů ani do error objektů.
 */
export async function pollDeviceToken(opts: PollDeviceTokenOptions): Promise<DeviceTokens> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + Math.max(opts.expiresInSec, 1) * 1000;
  let intervalMs = Math.max(opts.intervalSec, 1) * 1000;
  let pollCount = 0;

  for (;;) {
    if (now() >= deadline) {
      throw new DeviceFlowError(
        "expired_token",
        "Platnost kódu pro spárování vypršela — vraťte se a začněte připojení znovu.",
      );
    }
    // Prodleva PŘED každým pokusem (i prvním) — provider interval vyžaduje.
    await sleep(intervalMs);
    pollCount++;

    const params: Record<string, string> = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: opts.clientId,
      device_code: opts.deviceCode,
    };
    if (opts.clientSecret) params.client_secret = opts.clientSecret;

    let res: Response;
    try {
      res = await fetchImpl(googleTokenUrl(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      });
    } catch {
      // Přechodný výpadek sítě během čekání — zkoušej dál do vypršení.
      opts.onPending?.(pollCount);
      continue;
    }

    if (res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new DeviceFlowError("provider_error", "Google vrátil neplatnou odpověď — zkuste to prosím znovu.");
      }
      if (!isRecord(body) || typeof body.access_token !== "string") {
        throw new DeviceFlowError("provider_error", "Google vrátil neplatnou odpověď — zkuste to prosím znovu.");
      }
      if (typeof body.refresh_token !== "string") {
        throw new DeviceFlowError(
          "provider_error",
          "Google nevrátil refresh token — odeberte přístup aplikace na https://myaccount.google.com/permissions a připojte se znovu, aby se znovu zobrazil souhlas.",
        );
      }
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresIn: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600,
        scope: typeof body.scope === "string" ? body.scope : "",
      };
    }

    let errorCode = "";
    let errorDescription = "";
    try {
      const errBody: unknown = await res.json();
      if (isRecord(errBody)) {
        if (typeof errBody.error === "string") errorCode = errBody.error;
        if (typeof errBody.error_description === "string") errorDescription = errBody.error_description;
      }
    } catch {
      // Nečitelná chybová odpověď — padne do default větve níže.
    }
    switch (errorCode) {
      case "authorization_pending":
        opts.onPending?.(pollCount);
        continue;
      case "slow_down":
        intervalMs += SLOW_DOWN_STEP_SEC * 1000;
        opts.onPending?.(pollCount);
        continue;
      case "access_denied":
        throw new DeviceFlowError("access_denied", "Na zařízení jste připojení zamítli — zkuste to prosím znovu.");
      case "expired_token":
        throw new DeviceFlowError(
          "expired_token",
          "Platnost kódu pro spárování vypršela — vraťte se a začněte připojení znovu.",
        );
      case "invalid_client":
      case "unauthorized_client":
        // Chybný typ OAuth klienta (např. „Web" místo „TVs and Limited
        // Input devices") — dál pollovat nemá smysl.
        opts.log?.(
          `[oauth-device] token polling odmítnut: error=${errorCode} status=${res.status} ` +
            `popis=${redactForLog(errorDescription, [opts.clientId, opts.clientSecret ?? "", opts.deviceCode])}`,
        );
        throw new DeviceFlowError("invalid_client_type", INVALID_CLIENT_TYPE_MESSAGE);
      default:
        // Jiná fatální chyba poskytovatele — dál pollovat nemá smysl.
        // error_description se zaloguje (redakčně) pro diagnostiku, tělo
        // odpovědi se do zprávy pro uživatele nekopíruje.
        opts.log?.(
          `[oauth-device] token polling selhal: error=${errorCode || "neznámá"} status=${res.status} ` +
            `popis=${redactForLog(errorDescription, [opts.clientId, opts.clientSecret ?? "", opts.deviceCode])}`,
        );
        throw new DeviceFlowError(
          "provider_error",
          "Google párování odmítl — zkontrolujte nastavení OAuth klienta (typ „TV a zařízení s omezeným vstupem“) a zkuste to znovu.",
        );
    }
  }
}
