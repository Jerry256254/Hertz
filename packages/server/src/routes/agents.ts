import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agentMemory, agentProjects, agents, projects, sessions } from "../db/schema.js";
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

    // All agents company-wide (across every project) — used by the cross-project
    // "attach an existing employee" picker, since employees aren't confined to
    // their home project.
    instance.get("/api/agents", async () => {
      const rows = await ctx.db
        .select({ agent: agents, homeProjectName: projects.name })
        .from(agents)
        .innerJoin(projects, eq(agents.projectId, projects.id));
      return { agents: rows.map((r) => ({ ...r.agent, homeProjectName: r.homeProjectName })) };
    });

    // Home employees (agents.project_id = X) plus anyone attached via agent_projects.
    instance.get("/api/projects/:projectId/agents", async (request) => {
      const { projectId } = request.params as { projectId: string };
      const homeRows = await ctx.db.select().from(agents).where(eq(agents.projectId, projectId));

      const attachedRows = await ctx.db
        .select({ agent: agents })
        .from(agentProjects)
        .innerJoin(agents, eq(agentProjects.agentId, agents.id))
        .where(eq(agentProjects.projectId, projectId));

      const seen = new Set(homeRows.map((a) => a.id));
      const merged = [...homeRows];
      for (const { agent } of attachedRows) {
        if (!seen.has(agent.id)) {
          merged.push(agent);
          seen.add(agent.id);
        }
      }
      return { agents: merged };
    });

    // Attach an existing employee (hired anywhere) to this project's roster.
    instance.post("/api/projects/:projectId/agents/:agentId/attach", async (request, reply) => {
      const { projectId, agentId } = request.params as { projectId: string; agentId: string };
      const agentRows = await ctx.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
      const agent = agentRows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (agent.role === "manager") return reply.code(400).send({ error: "A manager can't be attached to another project" });
      if (agent.projectId === projectId) return reply.code(400).send({ error: "Already this project's home team" });

      const existing = await ctx.db
        .select({ id: agentProjects.id })
        .from(agentProjects)
        .where(and(eq(agentProjects.agentId, agentId), eq(agentProjects.projectId, projectId)))
        .limit(1);
      if (existing.length === 0) {
        await ctx.db.insert(agentProjects).values({ id: newId(), agentId, projectId, createdAt: new Date() });
      }
      return reply.code(201).send({ ok: true });
    });

    // Detach (without deleting the agent, which still belongs to its home project).
    instance.delete("/api/projects/:projectId/agents/:agentId/attach", async (request, reply) => {
      const { projectId, agentId } = request.params as { projectId: string; agentId: string };
      await ctx.db
        .delete(agentProjects)
        .where(and(eq(agentProjects.agentId, agentId), eq(agentProjects.projectId, projectId)));
      return reply.code(204).send();
    });

    instance.get("/api/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "Agent not found" });
      return row;
    });

    instance.get("/api/agents/:id/memory", async (request, reply) => {
      const { id } = request.params as { id: string };
      const agentRows = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!agentRows[0]) return reply.code(404).send({ error: "Agent not found" });

      const notes = await ctx.db
        .select()
        .from(agentMemory)
        .where(eq(agentMemory.agentId, id))
        .orderBy(desc(agentMemory.createdAt));
      return { notes };
    });

    instance.delete("/api/agents/:id/memory/:noteId", async (request, reply) => {
      const { id, noteId } = request.params as { id: string; noteId: string };
      await ctx.db.delete(agentMemory).where(and(eq(agentMemory.id, noteId), eq(agentMemory.agentId, id)));
      return reply.code(204).send();
    });

    instance.delete("/api/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Agent not found" });

      const sessionRows = await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.agentId, id));
      if (sessionRows.some((s) => ctx.agentLoop.isRunning(s.id))) {
        return reply.code(409).send({ error: "Can't delete an agent while one of its sessions is running" });
      }

      // Deletes its sessions/messages, agent_projects, agent_memory, and
      // meeting_participants rows via ON DELETE CASCADE.
      await ctx.db.delete(agents).where(eq(agents.id, id));
      return reply.code(204).send();
    });
  });
}
