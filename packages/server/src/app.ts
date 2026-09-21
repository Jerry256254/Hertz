import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { AppContext } from "./context.js";
import { registerAuthPlugin } from "./auth/plugin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerFsBrowseRoutes } from "./routes/fs-browse.js";
import { registerMountRoutes } from "./routes/mounts.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerRoutineRoutes } from "./routes/routines.js";
import { registerShellRoutes } from "./routes/shells.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerVaultRoutes } from "./routes/vault.js";
import { registerUpdateRoutes } from "./routes/update.js";
import { registerScreenRoutes } from "./routes/screen.js";
import { registerResetRoute } from "./routes/admin-reset.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerApiTokenRoutes } from "./routes/api-tokens.js";
import { registerShareRoutes } from "./routes/share.js";
import { registerSessionWebsocket } from "./ws/session-hub.js";

export interface BuildAppOptions {
  /** Directory containing the built web SPA (index.html + assets). Omit to run API-only (e.g. `pnpm dev` against the Vite dev server). */
  webDistDir?: string;
}

export async function buildApp(ctx: AppContext, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });

  registerAuthPlugin(app, ctx.db);

  app.get("/api/health", async () => ({ ok: true }));

  registerSetupRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerProviderRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerAttachmentRoutes(app, ctx);
  registerFsBrowseRoutes(app, ctx);
  registerMountRoutes(app, ctx);
  registerUsageRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerRoutineRoutes(app, ctx);
  registerShellRoutes(app, ctx);
  registerOAuthRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerUpdateRoutes(app, ctx);
  registerScreenRoutes(app, ctx);
  registerResetRoute(app, ctx);
  registerChannelRoutes(app, ctx);
  registerApiTokenRoutes(app, ctx);
  registerShareRoutes(app, ctx);
  registerSessionWebsocket(app, ctx);

  if (options.webDistDir) {
    await app.register(fastifyStatic, {
      root: options.webDistDir,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api") || request.raw.url?.startsWith("/ws")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }
      reply.sendFile("index.html", options.webDistDir as string);
    });
  }

  return app;
}
