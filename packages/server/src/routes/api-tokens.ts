import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { apiTokens } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";
import { createApiToken, revokeApiToken } from "../auth/session-tokens.js";

const createSchema = z.object({ name: z.string().min(1).max(60) });

/**
 * Personal API tokens: Bearer htz_… credentials for scripts and external
 * integrations. A token carries the owner's identity, so every existing
 * endpoint (post a message, list sessions, approve…) works unchanged —
 * `curl -H "Authorization: Bearer htz_…"`.
 */
export function registerApiTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/tokens", async (request) => {
      const rows = await ctx.db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          prefixHint: apiTokens.prefixHint,
          createdAt: apiTokens.createdAt,
          lastUsedAt: apiTokens.lastUsedAt,
        })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, request.user!.id), isNull(apiTokens.revokedAt)))
        .orderBy(desc(apiTokens.createdAt));
      return { tokens: rows };
    });

    instance.post("/api/tokens", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const created = await createApiToken(ctx.db, request.user!.id, parsed.data.name);
      return reply.code(201).send(created);
    });

    instance.delete("/api/tokens/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = await revokeApiToken(ctx.db, request.user!.id, id);
      if (!ok) return reply.code(404).send({ error: "Token not found" });
      return { ok: true };
    });
  });
}
