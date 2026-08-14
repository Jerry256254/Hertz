import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { users } from "../db/schema.js";
import { verifyPassword } from "../auth/password.js";
import { createSessionToken, revokeSessionToken } from "../auth/session-tokens.js";
import { SESSION_COOKIE_NAME } from "../auth/plugin.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }

    const rows = await ctx.db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
    const user = rows[0];
    if (!user || !(await verifyPassword(user.passwordHash, parsed.data.password))) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    const token = await createSessionToken(ctx.db, user.id);
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });
    return { token, user: { id: user.id, email: user.email, role: user.role } };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = (request.cookies as Record<string, string | undefined>)[SESSION_COOKIE_NAME];
    if (token) await revokeSessionToken(ctx.db, token);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "Not authenticated" });
    return { user: request.user };
  });
}
