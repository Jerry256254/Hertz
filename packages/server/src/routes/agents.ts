import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agents } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { AGENT_ROLES, defaultSystemPromptFor } from "../tools/org-tools.js";

const createSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  model: z.string().min(1),
  providerConfigId: z.string().min(1),
  role: z.enum(AGENT_ROLES).default("generalist"),
  systemPrompt: z.string().optional(),
});

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.post("/api/agents", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      if (parsed.data.role === "manager") {
        const existing = await ctx.db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.projectId, parsed.data.projectId), eq(agents.role, "manager")))
          .limit(1);
        if (existing.length > 0) {
          return reply.code(400).send({ error: "This project already has a manager" });
        }
      }

      const id = newId();
      await ctx.db.insert(agents).values({
        id,
        projectId: parsed.data.projectId,
        providerConfigId: parsed.data.providerConfigId,
        name: parsed.data.name,
        role: parsed.data.role,
        model: parsed.data.model,
        systemPrompt: parsed.data.systemPrompt ?? defaultSystemPromptFor(parsed.data.role),
        mode: "manual",
        status: "idle",
        createdAt: new Date(),
      });
      return reply.code(201).send({ id });
    });

    instance.get("/api/projects/:projectId/agents", async (request) => {
      const { projectId } = request.params as { projectId: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.projectId, projectId));
      return { agents: rows };
    });

    instance.get("/api/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "Agent not found" });
      return row;
    });
  });
}
