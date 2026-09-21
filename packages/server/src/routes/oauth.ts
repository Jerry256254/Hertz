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
async function resolveAppCredentials(
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

export function registerOAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

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

      const target = targetFor(service, payload.catalogId);
      // Re-connecting refreshes the stored tokens instead of stacking
      // duplicate rows: match by the spawned server binary + agent scope.
      const existingRows = await ctx.db.select().from(mcpServers);
      const existing = existingRows.find(
        (r) =>
          (r.agentId ?? null) === (payload.agentId ?? null) &&
          (JSON.parse(r.argsJson ?? "[]") as string[])[0] === target.args[0],
      );
      const encryptedEnv = encryptSecret(ctx.masterKey, JSON.stringify(env));
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
          agentId: payload.agentId,
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

      return reply.redirect(`/?connected=${encodeURIComponent(target.name)}`);
    });
  });
}
