import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { agents, employeeMessages } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";

export function registerEmployeeMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/projects/:projectId/employee-messages", async (request) => {
      const { projectId } = request.params as { projectId: string };

      const fromAgents = agents;
      const rows = await ctx.db
        .select({
          id: employeeMessages.id,
          fromAgentId: employeeMessages.fromAgentId,
          toAgentId: employeeMessages.toAgentId,
          body: employeeMessages.body,
          createdAt: employeeMessages.createdAt,
          fromName: fromAgents.name,
        })
        .from(employeeMessages)
        .innerJoin(fromAgents, eq(employeeMessages.fromAgentId, fromAgents.id))
        .where(eq(employeeMessages.projectId, projectId))
        .orderBy(desc(employeeMessages.createdAt))
        .limit(100);

      const agentRows = await ctx.db.select({ id: agents.id, name: agents.name }).from(agents);
      const nameById = new Map(agentRows.map((a) => [a.id, a.name]));

      return {
        messages: rows.map((r) => ({ ...r, toName: nameById.get(r.toAgentId) ?? "?" })).reverse(),
      };
    });
  });
}
