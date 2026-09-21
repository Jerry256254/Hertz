import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { mcpServers, oauthApps } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { encryptSecret, decryptSecret, maskKey } from "../secrets/key-encryption.js";
import {
  exchangeGithubCode,
  exchangeGoogleCode,
  exchangeMistralCode,
  exchangeNotionCode,
  exchangeSlackCode,
  generatePkcePair,
  githubAuthUrl,
  googleAuthUrl,
  googleScopesFor,
  mistralAuthUrl,
  notionAuthUrl,
  refreshMistralToken,
  serverOAuthApp,
  signState,
  slackAuthUrl,
  verifyState,
  type OAuthService,
  type OAuthStatePayload,
} from "../oauth/oauth-service.js";
import {
  DeviceFlowError,
  DEVICE_FLOW_GUIDED_ERRORS,
  GOOGLE_DEVICE_CLIENT_GUIDE_URL,
  pollDeviceToken,
  requestDeviceCode,
  type DeviceFlowErrorCode,
  type DeviceFlowLogger,
  type DeviceSessionStatus,
} from "../oauth/device-flow.js";
import {
  checkRedirectUri,
  localNetworkOAuthBlockedMessage,
  PROVIDERS_REQUIRING_PUBLIC_REDIRECT,
} from "../oauth/redirect-check.js";
import { oauthRelayBounceUrl, signRelayState } from "../oauth/relay-state.js";
import { providerConfigs } from "../db/schema.js";
import { getConnector, type ConnectorId } from "../mcp/catalog.js";

const require = createRequire(import.meta.url);
const mcpGoogleServerPath = require.resolve("@kuclab-hertz/mcp-google/dist/server.js");
const mcpNotionServerPath = require.resolve("@kuclab-hertz/mcp-notion/dist/server.js");
const mcpGithubServerPath = require.resolve("@kuclab-hertz/mcp-github/dist/server.js");

const upsertAppSchema = z.object({
  service: z.enum(["google", "slack", "mistral", "notion", "github"]),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().default(""),
});

interface OAuthTarget {
  connectorId: ConnectorId | null;
  name: string;
  command: string;
  args: string[];
}

/**
 * Maps an OAuth flow to the MCP server it provisions. Google supports the
 * legacy per-service catalogIds ("gmail", "google-drive", "google-calendar")
 * plus the one-click "google" id that enables Gmail + Kalendář + Disk at once.
 */
function targetFor(service: OAuthService, catalogId: string): OAuthTarget {
  if (service === "google") {
    if (catalogId === "gmail") return { connectorId: "google", name: "Gmail", command: "node", args: [mcpGoogleServerPath] };
    if (catalogId === "google-drive") return { connectorId: "google", name: "Google Drive", command: "node", args: [mcpGoogleServerPath] };
    if (catalogId === "google-calendar") return { connectorId: "google", name: "Google Kalendář", command: "node", args: [mcpGoogleServerPath] };
    return { connectorId: "google", name: "Google", command: "node", args: [mcpGoogleServerPath] };
  }
  if (service === "notion") return { connectorId: "notion", name: "Notion", command: "node", args: [mcpNotionServerPath] };
  if (service === "github") return { connectorId: "github", name: "GitHub", command: "node", args: [mcpGithubServerPath] };
  return { connectorId: null, name: "Slack", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"] };
}

function googleEnabledApis(catalogId: string): string {
  if (catalogId === "gmail") return "gmail";
  if (catalogId === "google-drive") return "drive";
  if (catalogId === "google-calendar") return "calendar";
  return "gmail,calendar,drive,sheets,docs,slides";
}

const SERVICE_CZ: Record<OAuthService, string> = {
  google: "Google",
  slack: "Slack",
  mistral: "Mistral",
  notion: "Notion",
  github: "GitHub",
};

/**
 * Přihlašovací údaje OAuth aplikace pro službu: nejdřív ty uložené v DB
 * (Nastavení → Konektory, krok pro správce), jinak ty nastavené správcem
 * serveru přes proměnné prostředí HERTZ_OAUTH_<SERVICE>_CLIENT_ID/SECRET.
 * Když neexistují ani jedny, běžný uživatel vidí jen lidskou výzvu, aby
 * poprosil správce — žádné technické detaily.
 */
export async function resolveAppCredentials(
  ctx: AppContext,
  service: OAuthService,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const rows = await ctx.db.select().from(oauthApps).where(eq(oauthApps.service, service)).limit(1);
  if (rows[0]) {
    return { clientId: rows[0].clientId, clientSecret: decryptSecret(ctx.masterKey, rows[0].encryptedClientSecret) };
  }
  return serverOAuthApp(service);
}

export interface OAuthStartParams {
  service: OAuthService;
  /** Přímá callback URL této instance (bez relay) — základ i pro relay target. */
  instanceCallbackUri: string;
  /** Podepsaný Hertz state (služba, konektor, uživatel); u Mistralu včetně PKCE verifieru. */
  statePayload: OAuthStatePayload;
  masterKey: Buffer;
}

export type OAuthStartPlan =
  | { ok: true; redirectUri: string; state: string; viaRelay: boolean }
  | { ok: false; error: string };

/**
 * Rozhodne, kam míří redirect_uri a jak vypadá state pro OAuth start.
 * Čistá funkce (závisí jen na env proměnných) — testovatelná bez Fastify/DB.
 *
 * Když je nastavené HERTZ_OAUTH_RELAY_URL a služba je google/notion, jede
 * start přes relay: redirect_uri je `<relay>/bounce` a state je podepsaný
 * relay token, jehož target je callback URL instance s vnitřním podepsaným
 * Hertz state v query (`?state=…`) — callback endpoint pak po bounci funguje
 * beze změny. Kontrola privátní adresy se v tom případě přeskakuje:
 * poskytovatel privátní adresu instance vůbec nevidí.
 * Jinak (nebo pro ostatní služby) zůstává přímý flow včetně existujícího
 * varování pro privátní síť z redirect-check.ts.
 */
export function planOAuthStart(p: OAuthStartParams): OAuthStartPlan {
  const relayBounceUrl = p.service === "google" || p.service === "notion" ? oauthRelayBounceUrl() : undefined;
  if (relayBounceUrl) {
    const stateSecret = process.env.HERTZ_OAUTH_STATE_SECRET?.trim();
    if (!stateSecret) {
      return {
        ok: false,
        error:
          "Přihlášení teď nejde spustit: na serveru je zapnutý OAuth relay (HERTZ_OAUTH_RELAY_URL), ale chybí tajný klíč HERTZ_OAUTH_STATE_SECRET — musí být stejný jako na relay serveru. Popros správce serveru, ať ho nastaví, pak to zkus znovu.",
      };
    }
    const hertzState = signState(p.masterKey, p.statePayload);
    const target = `${p.instanceCallbackUri}?state=${encodeURIComponent(hertzState)}`;
    // relayBounceUrl je definované jen pro google/notion (viz výše), takže cast je bezpečný.
    const relayService = p.service as "google" | "notion";
    return {
      ok: true,
      redirectUri: relayBounceUrl,
      state: signRelayState(target, relayService, stateSecret),
      viaRelay: true,
    };
  }
  if (PROVIDERS_REQUIRING_PUBLIC_REDIRECT.has(p.service) && !checkRedirectUri(p.instanceCallbackUri).ok) {
    return { ok: false, error: localNetworkOAuthBlockedMessage({ service: p.service, redirectUri: p.instanceCallbackUri }) };
  }
  return {
    ok: true,
    redirectUri: p.instanceCallbackUri,
    state: signState(p.masterKey, p.statePayload),
    viaRelay: false,
  };
}

/**
 * redirect_uri pro výměnu autorizačního kódu za tokeny (callback endpoint).
 * KRITICKÉ: při relay flow musí být úplně stejná jako při autorizaci —
 * tedy bounce URL relay, ne přímá callback adresa instance. Google/Notion
 * by jinak výměnu odmítly chybou redirect_uri_mismatch.
 */
export function callbackRedirectUri(service: OAuthService, protocol: string, host: string | undefined): string {
  const relayBounceUrl = service === "google" || service === "notion" ? oauthRelayBounceUrl() : undefined;
  return relayBounceUrl ?? `${protocol}://${host}/api/oauth/${service}/callback`;
}

/**
 * Uloží (nebo při opakovaném připojení obnoví) MCP server pro dokončené
 * OAuth přihlášení — stejnou cestou pro web callback i device flow, aby
 * refresh tokenů a odpojení fungovaly beze změny.
 */
async function provisionConnectedService(
  ctx: AppContext,
  opts: { service: OAuthService; catalogId: string; agentId: string | null; env: Record<string, string> },
): Promise<{ serverId: string; name: string }> {
  const target = targetFor(opts.service, opts.catalogId);
  // Re-connecting refreshes the stored tokens instead of stacking
  // duplicate rows: match by the spawned server binary + agent scope.
  const existingRows = await ctx.db.select().from(mcpServers);
  const existing = existingRows.find(
    (r) =>
      (r.agentId ?? null) === (opts.agentId ?? null) &&
      (JSON.parse(r.argsJson ?? "[]") as string[])[0] === target.args[0],
  );
  const encryptedEnv = encryptSecret(ctx.masterKey, JSON.stringify(opts.env));
  let serverId: string;
  if (existing) {
    await ctx.db
      .update(mcpServers)
      .set({ encryptedEnv, enabled: true, name: target.name })
      .where(eq(mcpServers.id, existing.id));
    serverId = existing.id;
  } else {
    serverId = newId();
    await ctx.db.insert(mcpServers).values({
      id: serverId,
      agentId: opts.agentId,
      name: target.name,
      transport: "stdio",
      command: target.command,
      argsJson: JSON.stringify(target.args),
      encryptedEnv,
      url: null,
      enabled: true,
      createdAt: new Date(),
    });
  }
  ctx.mcpRegistry.invalidate(serverId);
  return { serverId, name: target.name };
}

export interface DeviceSession {
  id: string;
  userId: string;
  agentId: string | null;
  catalogId: string;
  clientId: string;
  /** Drží se jen v paměti serveru — nikdy se neposílá klientovi ani neloguje. */
  clientSecret: string;
  /** Drží se jen v paměti serveru — nikdy se neposílá klientovi ani neloguje. */
  deviceCode: string;
  /** Kód pro uživatele — vrací se ve start-response i ve statusu, dokud je session pending. */
  userCode: string;
  /** Adresa pro zadání kódu — vrací se ve start-response i ve statusu, dokud je session pending. */
  verificationUrl: string;
  intervalSec: number;
  expiresInSec: number;
  status: DeviceSessionStatus;
  /** Česká zpráva pro uživatele (jen u koncových stavů). */
  message?: string;
  /** Typovaný kód chyby pro frontend (hlavně u stavu "error"). */
  code?: DeviceFlowErrorCode;
  finishedAt?: number;
}

/**
 * In-memory mapa device-flow relací: session id → stav. Polling běží na
 * pozadí serveru; klient se na stav ptá přes GET /device/status.
 * Exportovaná pro testy (pruneDeviceSessions).
 */
export const deviceSessions = new Map<string, DeviceSession>();
const DEVICE_SESSION_TTL_MS = 10 * 60 * 1000;

export function pruneDeviceSessions(): void {
  if (deviceSessions.size < 100) return;
  const cutoff = Date.now() - DEVICE_SESSION_TTL_MS;
  for (const [id, s] of deviceSessions) {
    if (s.status !== "pending" && (s.finishedAt ?? 0) < cutoff) deviceSessions.delete(id);
  }
}

/**
 * Pozadí device flow: polluje token endpoint a po úspěchu uloží tokeny
 * stejnou cestou jako web callback. Nikdy neloguje secret, device_code
 * ani tokeny; do session.message jde jen česká zpráva pro uživatele.
 */
export async function runDevicePolling(ctx: AppContext, session: DeviceSession, log?: DeviceFlowLogger): Promise<void> {
  try {
    const tokens = await pollDeviceToken({
      clientId: session.clientId,
      clientSecret: session.clientSecret || undefined,
      deviceCode: session.deviceCode,
      intervalSec: session.intervalSec,
      expiresInSec: session.expiresInSec,
      log,
    });
    const env: Record<string, string> = {
      GOOGLE_CLIENT_ID: session.clientId,
      GOOGLE_CLIENT_SECRET: session.clientSecret,
      GOOGLE_ACCESS_TOKEN: tokens.accessToken,
      GOOGLE_REFRESH_TOKEN: tokens.refreshToken,
      GOOGLE_ENABLED_APIS: googleEnabledApis(session.catalogId),
    };
    await provisionConnectedService(ctx, {
      service: "google",
      catalogId: session.catalogId,
      agentId: session.agentId,
      env,
    });
    session.status = "connected";
  } catch (err) {
    if (err instanceof DeviceFlowError) {
      session.status = err.code === "access_denied" ? "denied" : err.code === "expired_token" ? "expired" : "error";
      session.message = err.message;
      session.code = err.code;
    } else {
      session.status = "error";
      session.message = "Párování se nezdařilo z neočekávaného důvodu — zkuste to prosím znovu.";
      session.code = "provider_error";
    }
  } finally {
    session.finishedAt = Date.now();
    // Výsledek necháme chvíli k přečtení, pak relaci uklidíme z paměti.
    setTimeout(() => {
      deviceSessions.delete(session.id);
    }, DEVICE_SESSION_TTL_MS).unref();
  }
}

export function registerOAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    // Nečitelné tělo požadavku (poškozené JSON, špatný content-type, …) —
    // Fastify defaultně vrací anglický chybový formát; pro device flow
    // sjednocujeme na strukturovanou českou chybu { code, error }.
    instance.setErrorHandler((error, request, reply) => {
      const shaped = error as { code?: unknown; statusCode?: unknown };
      const errCode = shaped.code;
      if (typeof errCode === "string" && errCode.startsWith("FST_ERR_CTP_")) {
        const status =
          typeof shaped.statusCode === "number" && shaped.statusCode >= 400 && shaped.statusCode < 500
            ? shaped.statusCode
            : 400;
        return reply.code(status).send({
          code: "bad_request",
          error: "Požadavek se nepodařilo přečíst (neplatné tělo požadavku) — zkuste to prosím znovu.",
        });
      }
      return reply.send(error);
    });

    instance.get("/api/oauth/apps", async () => {
      const rows = await ctx.db.select().from(oauthApps);
      return {
        apps: rows.map((r) => ({ service: r.service, clientId: r.clientId, secretHint: maskKey(decryptSecret(ctx.masterKey, r.encryptedClientSecret)) })),
      };
    });

    instance.post("/api/oauth/apps", async (request, reply) => {
      const parsed = upsertAppSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const existing = await ctx.db.select({ id: oauthApps.id }).from(oauthApps).where(eq(oauthApps.service, parsed.data.service)).limit(1);
      if (existing[0]) {
        // Prázdný secret = "neměnit": UI nechává pole prázdné, když uživatel mění jen Client ID.
        const update: { clientId: string; encryptedClientSecret?: string } = { clientId: parsed.data.clientId };
        if (parsed.data.clientSecret) update.encryptedClientSecret = encryptSecret(ctx.masterKey, parsed.data.clientSecret);
        await ctx.db.update(oauthApps).set(update).where(eq(oauthApps.service, parsed.data.service));
      } else {
        if (!parsed.data.clientSecret) {
          return reply.code(400).send({ error: "Client secret je povinný — bez něj se OAuth přihlášení nedokončí." });
        }
        await ctx.db.insert(oauthApps).values({ id: newId(), service: parsed.data.service, clientId: parsed.data.clientId, encryptedClientSecret: encryptSecret(ctx.masterKey, parsed.data.clientSecret), createdAt: new Date() });
      }
      return reply.code(201).send({ ok: true });
    });

    instance.delete("/api/oauth/apps/:service", async (request, reply) => {
      const parsed = z.enum(["google", "slack", "mistral", "notion", "github"]).safeParse((request.params as { service: string }).service);
      if (!parsed.success) return reply.code(400).send({ error: "Unknown service" });
      await ctx.db.delete(oauthApps).where(eq(oauthApps.service, parsed.data));
      return reply.code(204).send();
    });

    // Kicks off the real consent-screen redirect. GET (not POST) because the browser needs to navigate away.
    // Failures redirect back to the app (Czech message in ?oauthError=) instead of a bare JSON error page.
    instance.get("/api/oauth/:service/start", async (request, reply) => {
      const { service } = request.params as { service: OAuthService };
      const { catalogId, agentId, projectId } = request.query as { catalogId?: string; agentId?: string; projectId?: string };
      const fail = (msg: string) => reply.redirect(`/?oauthError=${encodeURIComponent(msg)}`);
      if ((service === "google" || service === "slack") && !catalogId) {
        return fail("Chybí identifikátor služby — zkuste to prosím znovu z Nastavení → Konektory.");
      }

      const creds = await resolveAppCredentials(ctx, service);
      if (!creds) {
        return fail(
          `Přihlášení přes ${SERVICE_CZ[service] ?? service} ještě není na tomto serveru zapnuté. Popros správce serveru, ať ho zapne — je to jednorázové nastavení.`,
        );
      }

      const instanceCallbackUri = `${request.protocol}://${request.headers.host}/api/oauth/${service}/callback`;

      const statePayload: OAuthStatePayload = {
        service,
        catalogId: catalogId ?? getConnector(service as ConnectorId)?.catalogId ?? "",
        agentId: agentId ?? null,
        projectId: projectId ?? null,
        userId: request.user!.id,
        nonce: randomUUID(),
      };
      // Mistral (PKCE): verifier musí být součástí podepsaného state ještě před plánováním startu.
      const pkce = service === "mistral" ? generatePkcePair() : null;
      const plan = planOAuthStart({
        service,
        instanceCallbackUri,
        statePayload: pkce ? { ...statePayload, codeVerifier: pkce.verifier } : statePayload,
        masterKey: ctx.masterKey,
      });
      if (!plan.ok) return fail(plan.error);
      const { redirectUri, state } = plan;

      let url: string;
      if (service === "mistral") {
        // pkce je pro mistral vždy nastavené (viz výše).
        url = mistralAuthUrl({ clientId: creds.clientId, redirectUri, state, challenge: pkce!.challenge });
      } else if (service === "google") {
        url = googleAuthUrl({ clientId: creds.clientId, redirectUri, catalogId: catalogId ?? "", state });
      } else if (service === "notion") {
        url = notionAuthUrl({ clientId: creds.clientId, redirectUri, state });
      } else if (service === "github") {
        url = githubAuthUrl({ clientId: creds.clientId, redirectUri, state });
      } else {
        url = slackAuthUrl({ clientId: creds.clientId, redirectUri, state });
      }
      return reply.redirect(url);
    });

    /** Refresh the Mistral OAuth access token (the provider config's key) in place. */
    instance.post("/api/oauth/mistral/refresh", async (request, reply) => {
      const userId = request.user!.id;
      const { oauthTokens, providerConfigs: pc } = await import("../db/schema.js");
      const tokenRows = await ctx.db.select().from(oauthTokens).where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.service, "mistral"))).limit(1);
      if (!tokenRows[0]) return reply.code(404).send({ error: "No Mistral OAuth login on this account" });
      const refreshToken = decryptSecret(ctx.masterKey, tokenRows[0].encryptedRefreshToken);
      const appRows = await ctx.db.select().from(oauthApps).where(eq(oauthApps.service, "mistral")).limit(1);
      const mistralCreds = appRows[0] ? { clientId: appRows[0].clientId } : serverOAuthApp("mistral");
      if (!mistralCreds) return reply.code(400).send({ error: "Mistral OAuth app removed" });

      try {
        const tokens = await refreshMistralToken({ clientId: mistralCreds.clientId, refreshToken });
        const cfgRows = await ctx.db.select().from(pc).where(and(eq(pc.userId, userId), eq(pc.label, "Mistral (Le Pro — OAuth)")));
        if (cfgRows[0]) {
          await ctx.db.update(pc).set({ encryptedKey: encryptSecret(ctx.masterKey, tokens.accessToken) }).where(eq(pc.id, cfgRows[0].id));
        }
        if (tokens.refreshToken) {
          await ctx.db.update(oauthTokens).set({ encryptedRefreshToken: encryptSecret(ctx.masterKey, tokens.refreshToken) }).where(eq(oauthTokens.id, tokenRows[0].id));
        }
        return { ok: true };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });

    // OAuth 2.0 Device Authorization Grant (RFC 8628): "click to play"
    // připojení Google bez redirect URI — pro instance na privátní IP,
    // kde web redirect Google odmítá. Polling běží na pozadí serveru,
    // klient se na stav ptá přes GET /device/status.
    instance.post("/api/oauth/google/device/start", async (request, reply) => {
      const { catalogId, agentId } = (request.body ?? {}) as { catalogId?: string; agentId?: string };
      const cid = typeof catalogId === "string" && catalogId ? catalogId : "google";

      // Pád DB / dešifrování nesmí propadnout jako anglické 500 bez kódu —
      // kontrakt device flow vyžaduje strukturovanou českou chybu.
      let creds: { clientId: string; clientSecret: string } | null;
      try {
        creds = await resolveAppCredentials(ctx, "google");
      } catch {
        return reply.code(500).send({
          code: "provider_error",
          error: "Nastavení OAuth klienta se nepodařilo načíst — zkuste to prosím znovu.",
        });
      }
      if (!creds) {
        return reply.code(400).send({
          code: "missing_client_id",
          error: "Nejdřív vlož Client ID TV klienta v Nastavení → Konektory (krok pro správce serveru).",
          guideUrl: GOOGLE_DEVICE_CLIENT_GUIDE_URL,
        });
      }

      let authz;
      try {
        authz = await requestDeviceCode(creds.clientId, googleScopesFor(cid), {
          log: (msg) => instance.log.warn(msg),
        });
      } catch (err) {
        const code: DeviceFlowErrorCode = err instanceof DeviceFlowError ? err.code : "provider_error";
        const error =
          err instanceof DeviceFlowError
            ? err.message
            : "Kód pro spárování se nepodařilo připravit — zkuste to prosím znovu.";
        return reply.code(502).send({
          code,
          error,
          ...(DEVICE_FLOW_GUIDED_ERRORS.includes(code) ? { guideUrl: GOOGLE_DEVICE_CLIENT_GUIDE_URL } : {}),
        });
      }

      pruneDeviceSessions();
      const session: DeviceSession = {
        id: randomUUID(),
        userId: request.user!.id,
        agentId: typeof agentId === "string" && agentId ? agentId : null,
        catalogId: cid,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        deviceCode: authz.deviceCode,
        userCode: authz.userCode,
        verificationUrl: authz.verificationUrlComplete ?? authz.verificationUrl,
        intervalSec: authz.interval,
        expiresInSec: authz.expiresIn,
        status: "pending",
      };
      deviceSessions.set(session.id, session);
      // Polling na pozadí — nečekáme na něj, klient polluje /device/status.
      void runDevicePolling(ctx, session, (msg) => instance.log.warn(msg));

      return {
        user_code: authz.userCode,
        verification_url: authz.verificationUrlComplete ?? authz.verificationUrl,
        expires_in: authz.expiresIn,
        device_session_id: session.id,
      };
    });

    instance.get("/api/oauth/google/device/status", async (request, reply) => {
      const { session } = request.query as { session?: string };
      const s = typeof session === "string" ? deviceSessions.get(session) : undefined;
      if (!s || s.userId !== request.user!.id) {
        return reply
          .code(404)
          .send({ code: "session_not_found", error: "Relace pro párování neexistuje nebo vypršela — začněte připojení znovu." });
      }
      return {
        status: s.status,
        // Dokud uživatel kód nepotvrdil, vracíme i samotný kód a adresu —
        // kdyby se start-response po cestě ztratila, UI má kód stále odkud vzít.
        ...(s.status === "pending" ? { user_code: s.userCode, verification_url: s.verificationUrl } : {}),
        ...(s.message ? { message: s.message } : {}),
        ...(s.code ? { code: s.code } : {}),
        ...(s.code && DEVICE_FLOW_GUIDED_ERRORS.includes(s.code) ? { guideUrl: GOOGLE_DEVICE_CLIENT_GUIDE_URL } : {}),
      };
    });

    // The provider redirects the browser back here after the user consents (or declines).
    instance.get("/api/oauth/:service/callback", async (request, reply) => {
      const { service } = request.params as { service: OAuthService };
      const { code, state, error } = request.query as { code?: string; state?: string; error?: string };

      // Back to the app root — the web UI opens Nastavení → Konektory and shows the message.
      const back = (query: string) => reply.redirect(`/${query}`);
      if (error) {
        const msg =
          error === "access_denied"
            ? `Připojení ${SERVICE_CZ[service] ?? service} bylo zrušeno — souhlas nebyl udělen. Můžete to zkusit znovu.`
            : `Poskytovatel vrátil chybu: ${error}`;
        return back(`?oauthError=${encodeURIComponent(msg)}`);
      }
      if (!code || !state) return back(`?oauthError=${encodeURIComponent("Chybí autorizační kód — zkuste připojení zopakovat.")}`);

      const payload = verifyState(ctx.masterKey, state);
      if (!payload || payload.service !== service) {
        return back(`?oauthError=${encodeURIComponent("Neplatný stav připojení (state) — zkuste to prosím znovu z Nastavení → Konektory.")}`);
      }

      const creds = await resolveAppCredentials(ctx, service);
      if (!creds) {
        return back(
          `?oauthError=${encodeURIComponent(`Přihlášení přes ${SERVICE_CZ[service] ?? service} není na tomto serveru zapnuté — popros správce serveru, ať ho zapne.`)}`,
        );
      }

      if (service === "mistral") {
        const tokens = await exchangeMistralCode({
          clientId: creds.clientId,
          redirectUri: `${request.protocol}://${request.headers.host}/api/oauth/mistral/callback`,
          code,
          verifier: payload.codeVerifier ?? "",
        });

        // The OAuth access token IS the API key for api.mistral.ai.
        await ctx.db.insert(providerConfigs).values({
          id: newId(),
          userId: payload.userId,
          provider: "openai-compatible",
          label: "Mistral (Le Pro — OAuth)",
          baseUrl: "https://api.mistral.ai/v1",
          encryptedKey: encryptSecret(ctx.masterKey, tokens.accessToken),
          createdAt: new Date(),
        });

        if (tokens.refreshToken) {
          const { oauthTokens } = await import("../db/schema.js");
          await ctx.db.delete(oauthTokens).where(and(eq(oauthTokens.userId, payload.userId), eq(oauthTokens.service, "mistral")));
          await ctx.db.insert(oauthTokens).values({
            id: newId(),
            userId: payload.userId,
            service: "mistral",
            encryptedRefreshToken: encryptSecret(ctx.masterKey, tokens.refreshToken),
            createdAt: new Date(),
          });
        }

        return reply.redirect("/providers?mistralConnected=1");
      }
      const clientSecret = creds.clientSecret;
      // Při relay flow je redirect_uri pro výměnu kódu bounce URL relay —
      // musí být stejná jako při autorizaci, jinak poskytovatel vrátí
      // redirect_uri_mismatch. Bez relay zůstává přímá callback adresa.
      const redirectUri = callbackRedirectUri(service, request.protocol, request.headers.host);

      let env: Record<string, string>;
      try {
        if (service === "google") {
          const tokens = await exchangeGoogleCode({ clientId: creds.clientId, clientSecret, redirectUri, code });
          env = {
            GOOGLE_CLIENT_ID: creds.clientId,
            GOOGLE_CLIENT_SECRET: clientSecret,
            GOOGLE_ACCESS_TOKEN: tokens.accessToken,
            GOOGLE_REFRESH_TOKEN: tokens.refreshToken,
            GOOGLE_ENABLED_APIS: googleEnabledApis(payload.catalogId),
          };
        } else if (service === "notion") {
          const tokens = await exchangeNotionCode({ clientId: creds.clientId, clientSecret, redirectUri, code });
          env = { NOTION_API_KEY: tokens.accessToken };
        } else if (service === "github") {
          const tokens = await exchangeGithubCode({ clientId: creds.clientId, clientSecret, redirectUri, code });
          env = { GITHUB_TOKEN: tokens.accessToken };
        } else {
          const tokens = await exchangeSlackCode({ clientId: creds.clientId, clientSecret, redirectUri, code });
          env = { SLACK_BOT_TOKEN: tokens.botToken, SLACK_TEAM_ID: tokens.teamId };
        }
      } catch (err) {
        return back(`?oauthError=${encodeURIComponent(`Přihlášení u ${SERVICE_CZ[service] ?? service} se nezdařilo: ${(err as Error).message}`)}`);
      }

      const { name } = await provisionConnectedService(ctx, {
        service,
        catalogId: payload.catalogId,
        agentId: payload.agentId,
        env,
      });

      return reply.redirect(`/?connected=${encodeURIComponent(name)}`);
    });
  });
}
