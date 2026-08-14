import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PROVIDER_PRESETS } from "@kuclab-hertz/providers";
import type { AppContext } from "../context.js";
import { createUser, hasAnyUser } from "../bootstrap.js";
import { createSessionToken } from "../auth/session-tokens.js";
import { SESSION_COOKIE_NAME } from "../auth/plugin.js";

const bootstrapSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Public (unauthenticated) routes for the WebUI's first-run flow. Everything except
 * the network bind choice (still a CLI/wizard concern, since it decides what the
 * server listens on before any request can reach it) happens here: creating the
 * first admin account and picking a provider both live in the browser.
 */
export function registerSetupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/setup/status", async () => {
    return { needsSetup: !(await hasAnyUser(ctx)) };
  });

  app.get("/api/setup/presets", async () => {
    return { presets: PROVIDER_PRESETS };
  });

  app.post("/api/setup/bootstrap", async (request, reply) => {
    if (await hasAnyUser(ctx)) {
      return reply.code(403).send({ error: "Setup already completed" });
    }
    const parsed = bootstrapSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const userId = await createUser(ctx, parsed.data.email, parsed.data.password, "admin");
    const token = await createSessionToken(ctx.db, userId);
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });
    return reply.code(201).send({ token, user: { id: userId, email: parsed.data.email, role: "admin" } });
  });
}
