import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { mcpServers, oauthApps } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { encryptSecret, decryptSecret, maskKey } from "../secrets/key-encryption.js";
import {
  exchangeGoogleCode,
  exchangeSlackCode,
  googleAuthUrl,
  signState,
  slackAuthUrl,
  verifyState,
  type OAuthService,
} from "../oauth/oauth-service.js";

const require = createRequire(import.meta.url);
const mcpGoogleServerPath = require.resolve("@kuclab-hertz/mcp-google/dist/server.js");

const upsertAppSchema = z.object({
  service: z.enum(["google", "slack"]),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

interface OAuthTarget {
  name: string;
  command: string;
  args: string[];
}

function targetFor(service: OAuthService, catalogId: string): OAuthTarget {
  if (service === "google") {
    return {
      name: catalogId === "gmail" ? "Gmail" : "Google Drive",
      command: "node",
      args: [mcpGoogleServerPath],
    };
  }
  return { name: "Slack", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"] };
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
      const encryptedClientSecret = encryptSecret(ctx.masterKey, parsed.data.clientSecret);
      if (existing[0]) {
        await ctx.db.update(oauthApps).set({ clientId: parsed.data.clientId, encryptedClientSecret }).where(eq(oauthApps.service, parsed.data.service));
      } else {
        await ctx.db.insert(oauthApps).values({ id: newId(), service: parsed.data.service, clientId: parsed.data.clientId, encryptedClientSecret, createdAt: new Date() });
      }
      return reply.code(201).send({ ok: true });
    });

    instance.delete("/api/oauth/apps/:service", async (request, reply) => {
      const parsed = z.enum(["google", "slack"]).safeParse((request.params as { service: string }).service);
      if (!parsed.success) return reply.code(400).send({ error: "Unknown service" });
      await ctx.db.delete(oauthApps).where(eq(oauthApps.service, parsed.data));
      return reply.code(204).send();
    });

    // Kicks off the real consent-screen redirect. GET (not POST) because the browser needs to navigate away.
    instance.get("/api/oauth/:service/start", async (request, reply) => {
      const { service } = request.params as { service: OAuthService };
      const { catalogId, agentId, projectId } = request.query as { catalogId?: string; agentId?: string; projectId?: string };
      if (!catalogId) return reply.code(400).send({ error: "catalogId is required" });

      const appRows = await ctx.db.select().from(oauthApps).where(eq(oauthApps.service, service)).limit(1);
      const appRow = appRows[0];
      if (!appRow) return reply.code(400).send({ error: `No ${service} OAuth app configured yet — add one in Integrations first.` });

      const redirectUri = `${request.protocol}://${request.headers.host}/api/oauth/${service}/callback`;
      const state = signState(ctx.masterKey, {
        service,
        catalogId,
        agentId: agentId ?? null,
        projectId: projectId ?? null,
        userId: request.user!.id,
        nonce: randomUUID(),
      });

      const url =
        service === "google"
          ? googleAuthUrl({ clientId: appRow.clientId, redirectUri, catalogId, state })
          : slackAuthUrl({ clientId: appRow.clientId, redirectUri, state });
      return reply.redirect(url);
    });

    // The provider redirects the browser back here after the user consents (or declines).
    instance.get("/api/oauth/:service/callback", async (request, reply) => {
      const { service } = request.params as { service: OAuthService };
      const { code, state, error } = request.query as { code?: string; state?: string; error?: string };

      const back = (query: string) => reply.redirect(`/integrations${query}`);
      if (error) return back(`?oauthError=${encodeURIComponent(error)}`);
      if (!code || !state) return back("?oauthError=missing_code");

      const payload = verifyState(ctx.masterKey, state);
      if (!payload || payload.service !== service) return back("?oauthError=invalid_state");

      const appRows = await ctx.db.select().from(oauthApps).where(eq(oauthApps.service, service)).limit(1);
      const appRow = appRows[0];
      if (!appRow) return back("?oauthError=app_not_configured");
      const clientSecret = decryptSecret(ctx.masterKey, appRow.encryptedClientSecret);
      const redirectUri = `${request.protocol}://${request.headers.host}/api/oauth/${service}/callback`;

      let env: Record<string, string>;
      try {
        if (service === "google") {
          const tokens = await exchangeGoogleCode({ clientId: appRow.clientId, clientSecret, redirectUri, code });
          env = {
            GOOGLE_CLIENT_ID: appRow.clientId,
            GOOGLE_CLIENT_SECRET: clientSecret,
            GOOGLE_ACCESS_TOKEN: tokens.accessToken,
            GOOGLE_REFRESH_TOKEN: tokens.refreshToken,
            GOOGLE_ENABLED_APIS: payload.catalogId === "gmail" ? "gmail" : "drive",
          };
        } else {
          const tokens = await exchangeSlackCode({ clientId: appRow.clientId, clientSecret, redirectUri, code });
          env = { SLACK_BOT_TOKEN: tokens.botToken, SLACK_TEAM_ID: tokens.teamId };
        }
      } catch (err) {
        return back(`?oauthError=${encodeURIComponent((err as Error).message)}`);
      }

      const target = targetFor(service, payload.catalogId);
      await ctx.db.insert(mcpServers).values({
        id: newId(),
        agentId: payload.agentId,
        name: target.name,
        transport: "stdio",
        command: target.command,
        argsJson: JSON.stringify(target.args),
        encryptedEnv: encryptSecret(ctx.masterKey, JSON.stringify(env)),
        url: null,
        enabled: true,
        createdAt: new Date(),
      });

      const dest = payload.projectId && payload.agentId ? `/projects/${payload.projectId}/agents/${payload.agentId}` : "/integrations";
      return reply.redirect(`${dest}?connected=${encodeURIComponent(target.name)}`);
    });
  });
}
