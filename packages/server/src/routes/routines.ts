import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agents, routines } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { computeNextRun, normalizeSchedule } from "../routines/routine-scheduler.js";

const createSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().min(1),
  taskTemplate: z.string().min(1),
  schedule: z.string().min(1),
});

const updateSchema = z.object({ enabled: z.boolean() });

export function registerRoutineRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.post("/api/projects/:projectId/routines", async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const agentRows = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, parsed.data.agentId)).limit(1);
      if (!agentRows[0]) return reply.code(400).send({ error: "Unknown agent" });

      const now = new Date();
      const schedule = normalizeSchedule(parsed.data.schedule, now);
      const id = newId();
      await ctx.db.insert(routines).values({
        id,
        projectId,
        agentId: parsed.data.agentId,
        title: parsed.data.title,
        taskTemplate: parsed.data.taskTemplate,
        schedule,
        enabled: true,
        lastRunAt: null,
        nextRunAt: schedule === "once" ? now : computeNextRun(schedule, now),
        createdAt: now,
      });
      return reply.code(201).send({ id, schedule });
    });

    instance.get("/api/projects/:projectId/routines", async (request) => {
      const { projectId } = request.params as { projectId: string };
      const rows = await ctx.db
        .select({ routine: routines, agentName: agents.name })
        .from(routines)
        .innerJoin(agents, eq(routines.agentId, agents.id))
        .where(eq(routines.projectId, projectId));
      return { routines: rows.map((r) => ({ ...r.routine, agentName: r.agentName })) };
    });

    instance.patch("/api/routines/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const rows = await ctx.db.select().from(routines).where(eq(routines.id, id)).limit(1);
      const routine = rows[0];
      if (!routine) return reply.code(404).send({ error: "Routine not found" });

      const now = new Date();
      await ctx.db
        .update(routines)
        .set({
          enabled: parsed.data.enabled,
          // Re-enabling a routine whose schedule already passed needs a fresh nextRunAt, or it fires immediately on the next tick.
          nextRunAt: parsed.data.enabled && routine.schedule !== "once" ? computeNextRun(routine.schedule, now) : routine.nextRunAt,
        })
        .where(eq(routines.id, id));
      return { ok: true };
    });

    instance.delete("/api/routines/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: routines.id }).from(routines).where(eq(routines.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Routine not found" });

      await ctx.db.delete(routines).where(eq(routines.id, id));
      return reply.code(204).send();
    });
  });
}
