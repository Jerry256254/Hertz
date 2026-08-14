import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { AppContext } from "../context.js";
import { agentProjects, agents, projectRoots, sessions, taskAssignees, tasks } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { buildSystemPrompt } from "../agents/system-prompt.js";

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  assigneeAgentIds: z.array(z.string().min(1)).min(1),
});

const updateTaskSchema = z.object({
  status: z.enum(["open", "in_progress", "done"]),
});

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.post("/api/projects/:projectId/tasks", async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const parsed = createTaskSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const rootRows = await ctx.db.select().from(projectRoots).where(eq(projectRoots.projectId, projectId));
      const mainRoot = rootRows.find((r) => r.rootId === "main") ?? rootRows[0];
      if (!mainRoot) return reply.code(400).send({ error: "Project has no root directory configured" });

      const assignees = [];
      for (const agentId of parsed.data.assigneeAgentIds) {
        const rows = await ctx.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
        const agent = rows[0];
        if (!agent) return reply.code(400).send({ error: `Unknown agent: ${agentId}` });
        if (agent.projectId !== projectId) {
          const attached = await ctx.db
            .select({ id: agentProjects.id })
            .from(agentProjects)
            .where(and(eq(agentProjects.agentId, agentId), eq(agentProjects.projectId, projectId)))
            .limit(1);
          if (attached.length === 0) {
            return reply.code(400).send({ error: `${agent.name} isn't on this project's team` });
          }
        }
        assignees.push(agent);
      }

      const taskId = newId();
      const now = new Date();
      await ctx.db.insert(tasks).values({
        id: taskId,
        projectId,
        title: parsed.data.title,
        description: parsed.data.description,
        status: "in_progress",
        createdAt: now,
        updatedAt: now,
      });

      for (const agent of assignees) {
        const sessionId = newId();
        await ctx.db.insert(sessions).values({
          id: sessionId,
          agentId: agent.id,
          projectId,
          title: parsed.data.title,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert(taskAssignees).values({ id: newId(), taskId, agentId: agent.id, sessionId });

        ctx.sandboxRegistry.register(sessionId, { [mainRoot.rootId]: mainRoot.absolutePath });
        const content: ContentBlock[] = [
          { type: "text", text: `You've been assigned a task by the user.\n\n## ${parsed.data.title}\n\n${parsed.data.description}` },
        ];
        ctx.agentLoop.start(
          {
            sessionId,
            agentId: agent.id,
            projectId,
            userId: request.user!.id,
            rootId: mainRoot.rootId,
            model: agent.model,
            providerConfigId: agent.providerConfigId,
            systemPrompt: await buildSystemPrompt(ctx.db, agent),
          },
          content,
        );
      }

      return reply.code(201).send({ id: taskId });
    });

    instance.get("/api/projects/:projectId/tasks", async (request) => {
      const { projectId } = request.params as { projectId: string };
      const taskRows = await ctx.db.select().from(tasks).where(eq(tasks.projectId, projectId));
      const withAssignees = await Promise.all(
        taskRows.map(async (task) => {
          const assigneeRows = await ctx.db
            .select({ assignee: taskAssignees, agentName: agents.name, agentRole: agents.role })
            .from(taskAssignees)
            .innerJoin(agents, eq(taskAssignees.agentId, agents.id))
            .where(eq(taskAssignees.taskId, task.id));
          return {
            ...task,
            assignees: assigneeRows.map((r) => ({
              id: r.assignee.id,
              agentId: r.assignee.agentId,
              sessionId: r.assignee.sessionId,
              agentName: r.agentName,
              agentRole: r.agentRole,
            })),
          };
        }),
      );
      return { tasks: withAssignees };
    });

    instance.get("/api/tasks/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const taskRows = await ctx.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
      const task = taskRows[0];
      if (!task) return reply.code(404).send({ error: "Task not found" });

      const assigneeRows = await ctx.db
        .select({ assignee: taskAssignees, agentName: agents.name, agentRole: agents.role })
        .from(taskAssignees)
        .innerJoin(agents, eq(taskAssignees.agentId, agents.id))
        .where(eq(taskAssignees.taskId, id));

      return {
        ...task,
        assignees: assigneeRows.map((r) => ({
          id: r.assignee.id,
          agentId: r.assignee.agentId,
          sessionId: r.assignee.sessionId,
          agentName: r.agentName,
          agentRole: r.agentRole,
        })),
      };
    });

    instance.patch("/api/tasks/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateTaskSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const rows = await ctx.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Task not found" });

      await ctx.db.update(tasks).set({ status: parsed.data.status, updatedAt: new Date() }).where(eq(tasks.id, id));
      return { ok: true };
    });

    instance.delete("/api/tasks/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Task not found" });

      await ctx.db.delete(tasks).where(eq(tasks.id, id));
      return reply.code(204).send();
    });
  });
}
