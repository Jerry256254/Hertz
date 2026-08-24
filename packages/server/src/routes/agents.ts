import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agentMemory, agentProjects, agents, messages, projectRoots, projects, sessions } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { hasProjectAccess } from "../auth/project-access.js";
import { AGENT_ROLES, defaultSystemPromptFor, pickMascot } from "../tools/org-tools.js";
import { employeeDir, ensureEmployeeDirs } from "../paths.js";
import { skillsIndexFor } from "../tools/skill-tools.js";

const createSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  model: z.string().min(1),
  providerConfigId: z.string().min(1),
  role: z.enum(AGENT_ROLES).default("generalist"),
  systemPrompt: z.string().optional(),
  mascot: z.string().min(1).max(8).optional(),
  jobDescription: z.string().optional(),
});

const approvalSchema = z.object({ approvalStatus: z.enum(["approved", "rejected"]) });

const updateSchema = z.object({
  model: z.string().min(1).optional(),
  providerConfigId: z.string().min(1).optional(),
  computerBackend: z.enum(["local", "docker"]).optional(),
  computerImage: z.string().min(1).nullable().optional(),
  /** Proactive self-wake interval; 0 disables heartbeats. */
  heartbeatMinutes: z.number().int().min(0).max(10080).optional(),
  heartbeatPrompt: z.string().max(4000).nullable().optional(),
  /** Mascot emoji shown as the agent's animated avatar everywhere. */
  mascot: z.string().min(1).max(8).nullable().optional(),
});

const terminationDecisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) });

const ensureChatSchema = z.object({ projectId: z.string().min(1) });

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.post("/api/agents", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (!(await hasProjectAccess(ctx.db, request.user!, parsed.data.projectId))) {
        return reply.code(403).send({ error: "No access to this project" });
      }

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
        mascot: parsed.data.mascot ?? pickMascot(id),
        role: parsed.data.role,
        model: parsed.data.model,
        systemPrompt: parsed.data.systemPrompt ?? defaultSystemPromptFor(parsed.data.role),
        jobDescription: parsed.data.jobDescription,
        mode: "manual",
        status: "idle",
        createdAt: new Date(),
      });
      return reply.code(201).send({ id });
    });

    // The user (CEO) approving or rejecting a manager's hire_employee request.
    instance.patch("/api/agents/:id/approval", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = approvalSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (agent.approvalStatus !== "pending") {
        return reply.code(400).send({ error: "This hire has already been decided" });
      }

      await ctx.db.update(agents).set({ approvalStatus: parsed.data.approvalStatus }).where(eq(agents.id, id));
      return { ok: true };
    });

    // The user (CEO) changing an agent's model/provider — always allowed, any agent, any time.
    instance.patch("/api/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: "Nothing to update" });

      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) {
        return reply.code(403).send({ error: "No access to this project" });
      }

      await ctx.db.update(agents).set(parsed.data).where(eq(agents.id, id));
      return { ok: true };
    });

    /** Status of the agent's own computer — auto-creates the container when missing. */
    instance.get("/api/agents/:id/computer", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });

      const dockerState = await ctx.computer.status(id);
      if (dockerState === "unavailable") {
        return { backend: "docker", status: "unavailable", image: agent.computerImage ?? null, containerName: ctx.computer.containerName(id) };
      }

      // Auto-setup: no container yet (or stopped) → bring it up right here.
      if (dockerState === "missing" || dockerState === "stopped") {
        try {
          const rootRows = await ctx.db.select({ absolutePath: projectRoots.absolutePath }).from(projectRoots).where(eq(projectRoots.projectId, agent.projectId));
          const mainRoot = rootRows[0]?.absolutePath;
          await ensureEmployeeDirs(ctx.paths, agent.projectId, agent.id);
          await ctx.computer.ensureContainer({
            agentId: agent.id,
            image: agent.computerImage,
            mountPaths: [...new Set([...(mainRoot ? [mainRoot] : []), employeeDir(ctx.paths, agent.projectId, agent.id)])],
          });
          void ctx.desktop.start(agent.id).catch(() => {});
        } catch (err) {
          return { backend: "docker", status: dockerState, image: agent.computerImage ?? null, containerName: ctx.computer.containerName(id), error: (err as Error).message };
        }
      }

      const state = await ctx.computer.status(id);
      return { backend: "docker", status: state, image: agent.computerImage ?? null, containerName: ctx.computer.containerName(id) };
    });

    /** Restart (recreate) the agent's computer — e.g. after a broken state or to pick up a new image. */
    /**
     * Contacts model: every agent has EXACTLY ONE permanent chat thread per
     * project. Returns it — creating it on first touch. The sidebar renders
     * agents (contacts), not raw sessions.
     */
    instance.post("/api/agents/:id/ensure-chat", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = ensureChatSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const projectId = parsed.data.projectId;

      const agentRows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = agentRows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (agent.approvalStatus !== "approved") return reply.code(400).send({ error: `${agent.name} isn't approved` });
      if (agent.status === "terminated") return reply.code(400).send({ error: `${agent.name} has been terminated` });

      const existing = await ctx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.agentId, id), eq(sessions.projectId, projectId), eq(sessions.kind, "chat")))
        .orderBy(desc(sessions.updatedAt))
        .limit(1);
      if (existing[0]) return { id: existing[0].id };

      const sid = newId();
      const now = new Date();
      await ctx.db.insert(sessions).values({
        id: sid,
        agentId: id,
        projectId,
        title: agent.name,
        mode: "autonomous",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return reply.code(201).send({ id: sid });
    });

    /** Clears the agent's chat history (messages only — memory and skills stay). */
    instance.post("/api/agents/:id/clear-chat", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = ensureChatSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const projectId = parsed.data.projectId;

      const chatRows = await ctx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.agentId, id), eq(sessions.projectId, projectId), eq(sessions.kind, "chat")));
      for (const s of chatRows) {
        if (ctx.agentLoop.isRunning(s.id)) {
          return reply.code(409).send({ error: "The agent is running — stop it before clearing the chat." });
        }
        await ctx.db.delete(messages).where(eq(messages.sessionId, s.id));
        await ctx.db.update(sessions).set({ status: "active", metadata: null, updatedAt: new Date() }).where(eq(sessions.id, s.id));
      }
      return { ok: true, cleared: chatRows.length };
    });

    instance.post("/api/agents/:id/computer/restart", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (agent.computerBackend !== "docker") {
        return reply.code(400).send({ error: "This agent runs locally — nothing to restart" });
      }
      try {
        await ctx.computer.destroyContainer(id);
        const rootRows = await ctx.db.select({ absolutePath: projectRoots.absolutePath }).from(projectRoots).where(eq(projectRoots.projectId, agent.projectId));
        const mainRoot = rootRows[0]?.absolutePath;
        await ensureEmployeeDirs(ctx.paths, agent.projectId, agent.id);
        await ctx.computer.ensureContainer({
          agentId: agent.id,
          image: agent.computerImage,
          mountPaths: mainRoot ? [mainRoot, employeeDir(ctx.paths, agent.projectId, agent.id)] : [employeeDir(ctx.paths, agent.projectId, agent.id)],
        });
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    });

    // The user (CEO) approving or rejecting a manager's fire_employee request.
    instance.patch("/api/agents/:id/termination", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = terminationDecisionSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!agent.pendingTermination) return reply.code(400).send({ error: "This agent has no pending termination request" });

      if (parsed.data.decision === "approved") {
        await ctx.db.update(agents).set({ status: "terminated", pendingTermination: false }).where(eq(agents.id, id));
      } else {
        await ctx.db.update(agents).set({ pendingTermination: false }).where(eq(agents.id, id));
      }
      return { ok: true };
    });

    /** The agent's personal skill library (index only — full text lives on disk). */
    instance.get("/api/agents/:id/skills", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Agent not found" });
      return { skills: await skillsIndexFor(ctx.paths, id) };
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
    instance.get("/api/projects/:projectId/agents", async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) return reply.code(403).send({ error: "No access to this project" });
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
