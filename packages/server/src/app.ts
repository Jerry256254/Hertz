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
import { registerFsBrowseRoutes } from "./routes/fs-browse.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerMeetingRoutes } from "./routes/meetings.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerRoutineRoutes } from "./routes/routines.js";
import { registerShellRoutes } from "./routes/shells.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerSessionWebsocket } from "./ws/session-hub.js";
import { registerMeetingWebsocket } from "./ws/meeting-hub.js";

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
  registerFsBrowseRoutes(app, ctx);
  registerUsageRoutes(app, ctx);
  registerMeetingRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerRoutineRoutes(app, ctx);
  registerShellRoutes(app, ctx);
  registerOAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerSessionWebsocket(app, ctx);
  registerMeetingWebsocket(app, ctx);

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
