import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agents } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";

const createSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  model: z.string().min(1),
  providerConfigId: z.string().min(1),
  systemPrompt: z.string().optional(),
});

const DEFAULT_SYSTEM_PROMPT = `You are a KucLab Hertz agent: a colleague working directly on the user's project files, not a chat assistant. Use the available tools to read, write, and edit real files, run allowlisted shell commands, and search the codebase. Prefer ranged reads over whole-file reads. Be direct and make real changes rather than only describing them.`;

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.post("/api/agents", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const id = newId();
      await ctx.db.insert(agents).values({
        id,
        projectId: parsed.data.projectId,
        providerConfigId: parsed.data.providerConfigId,
        name: parsed.data.name,
        model: parsed.data.model,
        systemPrompt: parsed.data.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
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
