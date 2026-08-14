import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { usageRecords } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";

const querySchema = z.object({ sessionId: z.string().optional() });

export function registerUsageRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/usage", async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const rows = parsed.data.sessionId
        ? await ctx.db
            .select()
            .from(usageRecords)
            .where(eq(usageRecords.sessionId, parsed.data.sessionId))
            .orderBy(desc(usageRecords.at))
        : await ctx.db
            .select()
            .from(usageRecords)
            .where(eq(usageRecords.userId, request.user!.id))
            .orderBy(desc(usageRecords.at))
            .limit(200);

      const totalCost = rows.reduce((sum, r) => sum + r.cost, 0);
      return { records: rows, totalCost };
    });
  });
}
