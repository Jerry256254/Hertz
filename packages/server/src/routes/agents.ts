import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agentMemory, agentMemoryAtoms, agentMemoryScenarios, agents, messages, projectRoots, sessions } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { hasProjectAccess } from "../auth/project-access.js";
import { employeeDir, ensureEmployeeDirs } from "../paths.js";
import { mountsFor } from "../mounts/mounts.js";
import { skillsIndexFor } from "../tools/skill-tools.js";
import { forgetById, loadPersona } from "../memory/recall.js";
import { removeAgentVectors, removeAtomVector } from "../memory/vector-store.js";
import { ensureAgent } from "../bootstrap.js";

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  model: z.string().min(1).optional(),
  providerConfigId: z.string().min(1).optional(),
  systemPrompt: z.string().max(20_000).nullable().optional(),
  // VM-only isolation: the API can only select 'docker'. Pre-existing 'local'
  // rows are grandfathered (they keep working) but cannot be created anew.
  computerBackend: z.enum(["docker"]).optional(),
  computerImage: z.string().min(1).nullable().optional(),
  /** Proactive self-wake interval; 0 disables heartbeats. */
  heartbeatMinutes: z.number().int().min(0).max(10080).optional(),
  heartbeatPrompt: z.string().max(4000).nullable().optional(),
  /** Avatar style seed shown as the agent's animated avatar everywhere. */
  mascot: z.string().min(1).max(8).nullable().optional(),
});

const ensureChatSchema = z.object({ projectId: z.string().min(1) });

const ensureAgentSchema = z.object({
  projectId: z.string().min(1),
  providerConfigId: z.string().min(1),
  model: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
});

/** Container bind-mount set for an agent: project root + personal dir + permanent mounts (via the one mountsFor helper). */
async function containerMounts(ctx: AppContext, agent: { id: string; projectId: string }): Promise<string[]> {
  const rootRows = await ctx.db.select({ absolutePath: projectRoots.absolutePath }).from(projectRoots).where(eq(projectRoots.projectId, agent.projectId));
  const mainRoot = rootRows[0]?.absolutePath;
  await ensureEmployeeDirs(ctx.paths, agent.projectId, agent.id);
  const mountRows = await mountsFor(ctx.db, agent.projectId, agent.id);
  return [...new Set([...(mainRoot ? [mainRoot] : []), employeeDir(ctx.paths, agent.projectId, agent.id), ...mountRows.map((m) => m.hostPath)])];
}

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    /** The single agent — bootstrapped on first setup, exactly one row. */
    instance.get("/api/agent", async (_request, reply) => {
      const rows = await ctx.db.select().from(agents).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "No agent yet — complete setup first" });
      // Honest isolation labelling for grandfathered local-backend agents.
      return { ...rows[0], isolated: rows[0].computerBackend === "docker" };
    });

    /** Idempotent bootstrap: returns the agent, creating it on first call (setup wizard). */
    instance.post("/api/agent/ensure", async (request, reply) => {
      const parsed = ensureAgentSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (!(await hasProjectAccess(ctx.db, request.user!, parsed.data.projectId))) {
        return reply.code(403).send({ error: "No access to this project" });
      }
      const id = await ensureAgent(ctx, parsed.data);
      return reply.code(201).send({ id });
    });

    // The user changing the agent's character — name, model/provider, soul prompt, avatar.
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
      if (parsed.data.providerConfigId) {
        const { providerConfigs } = await import("../db/schema.js");
        const pc = await ctx.db.select({ id: providerConfigs.id }).from(providerConfigs).where(eq(providerConfigs.id, parsed.data.providerConfigId)).limit(1);
        if (!pc[0]) return reply.code(400).send({ error: "Provider config not found" });
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
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) return reply.code(403).send({ error: "No access" });

      const dockerState = await ctx.computer.status(id);
      if (dockerState === "unavailable") {
        return { backend: "docker", status: "unavailable", image: agent.computerImage ?? null, containerName: ctx.computer.containerName(id) };
      }

      // Auto-setup: no container yet (or stopped) → bring it up right here.
      // A running container is reconciled too — syncMounts recreates it only
      // when the mount set drifted from the DB.
      try {
        await ctx.computer.ensureContainer({
          agentId: agent.id,
          image: agent.computerImage,
          mountPaths: await containerMounts(ctx, agent),
        });
        if (dockerState === "missing" || dockerState === "stopped") {
          void ctx.desktop.start(agent.id).catch(() => {});
        }
      } catch (err) {
        return { backend: "docker", status: dockerState, image: agent.computerImage ?? null, containerName: ctx.computer.containerName(id), error: (err as Error).message };
      }

      const state = await ctx.computer.status(id);
      return { backend: "docker", status: state, image: agent.computerImage ?? null, containerName: ctx.computer.containerName(id) };
    });

    /** Restart (recreate) the agent's computer — e.g. after a broken state or to pick up a new image. */
    instance.post("/api/agents/:id/computer/restart", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) return reply.code(403).send({ error: "No access" });
      if (agent.computerBackend !== "docker") {
        return reply.code(400).send({ error: "This agent runs locally — nothing to restart" });
      }
      try {
        await ctx.computer.destroyContainer(id);
        await ctx.computer.ensureContainer({
          agentId: agent.id,
          image: agent.computerImage,
          mountPaths: await containerMounts(ctx, agent),
        });
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    });

    /**
     * The main chat: exactly one permanent thread between the user and the
     * agent per project. Returns it — creating it on first touch.
     */
    instance.post("/api/agents/:id/ensure-chat", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = ensureChatSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const projectId = parsed.data.projectId;

      const agentRows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = agentRows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) return reply.code(403).send({ error: "No access to this project" });

      const existing = await ctx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.agentId, id))
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
      if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) return reply.code(403).send({ error: "No access" });

      const chatRows = await ctx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.agentId, id));
      for (const s of chatRows) {
        if (ctx.agentLoop.isRunning(s.id)) {
          return reply.code(409).send({ error: "The agent is running — stop it before clearing the chat." });
        }
        await ctx.db.delete(messages).where(eq(messages.sessionId, s.id));
        await ctx.db.update(sessions).set({ status: "active", metadata: null, updatedAt: new Date() }).where(eq(sessions.id, s.id));
      }
      return { ok: true, cleared: chatRows.length };
    });

    /** The agent's personal skill library (index only — full text lives on disk). */
    instance.get("/api/agents/:id/skills", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: agents.id, projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, (rows[0] as any).projectId))) return reply.code(403).send({ error: "No access" });
      return { skills: await skillsIndexFor(ctx.paths, rows[0].projectId, id) };
    });

    instance.get("/api/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, row.projectId))) return reply.code(403).send({ error: "No access" });
      // Honest isolation labelling for grandfathered local-backend agents.
      return { ...row, isolated: row.computerBackend === "docker" };
    });

    instance.get("/api/agents/:id/memory", async (request, reply) => {
      const { id } = request.params as { id: string };
      const agentRows = await ctx.db.select({ id: agents.id, projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!agentRows[0]) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agentRows[0].projectId))) return reply.code(403).send({ error: "No access" });

      const [atoms, scenarios, persona, legacy] = await Promise.all([
        ctx.db.select().from(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, id)).orderBy(desc(agentMemoryAtoms.createdAt)).limit(300),
        ctx.db.select().from(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, id)).orderBy(desc(agentMemoryScenarios.updatedAt)).limit(60),
        loadPersona(ctx.paths, agentRows[0].projectId, id).catch(() => ""),
        ctx.db.select().from(agentMemory).where(eq(agentMemory.agentId, id)).orderBy(desc(agentMemory.createdAt)).limit(50),
      ]);
      // `notes` stays for backwards compatibility (atoms mapped to the legacy shape).
      const notes = [
        ...atoms.map((a) => ({ id: a.id, agentId: a.agentId, note: a.text, createdAt: a.createdAt })),
        ...legacy.map((l) => ({ id: l.id, agentId: l.agentId, note: l.note, createdAt: l.createdAt })),
      ];
      return { notes, persona, scenarios, atoms };
    });

    instance.delete("/api/agents/:id/memory/:noteId", async (request, reply) => {
      const { id, noteId } = request.params as { id: string; noteId: string };
      const aRows = await ctx.db.select({ projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
      if (aRows[0] && !(await hasProjectAccess(ctx.db, request.user!, aRows[0].projectId))) return reply.code(403).send({ error: "No access" });
      await forgetById(ctx.db, id, noteId);
      removeAtomVector(ctx.paths, noteId);
      return reply.code(204).send();
    });

    instance.delete("/api/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: agents.id, projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, (rows[0] as any).projectId))) return reply.code(403).send({ error: "No access" });

      const sessionRows = await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.agentId, id));
      if (sessionRows.some((s) => ctx.agentLoop.isRunning(s.id))) {
        return reply.code(409).send({ error: "Can't delete the agent while one of its chats is running" });
      }

      // Deletes its sessions/messages and memory rows via ON DELETE CASCADE.
      await ctx.db.delete(agents).where(eq(agents.id, id));
      removeAgentVectors(ctx.paths, id);
      return reply.code(204).send();
    });
  });
}
