import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ContentBlock } from "@kuclab-hertz/providers";
import { computeBudget } from "@kuclab-hertz/core";
import type { AppContext } from "../context.js";
import { agentProjects, agents, projectRoots, projects, sessions } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { createPersistenceAdapter } from "../persistence/persistence-adapter.js";
import { buildSystemPrompt } from "../agents/system-prompt.js";

const DEFAULT_TITLE = "New chat";

const createSessionSchema = z.object({
  title: z.string().optional(),
  /** Which project this chat is about. Defaults to the agent's home project — required when the agent has been attached to more than one. */
  projectId: z.string().optional(),
});

const renameSessionSchema = z.object({
  title: z.string().min(1).max(200),
});

const sendMessageSchema = z.object({
  text: z.string().optional(),
  images: z
    .array(z.object({ mimeType: z.string(), data: z.string() }))
    .optional()
    .default([]),
});

function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
  instance.addHook("preHandler", requireAuth);

  instance.post("/api/agents/:agentId/sessions", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const parsed = createSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const agentRows = await ctx.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    const agent = agentRows[0];
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    const projectId = parsed.data.projectId ?? agent.projectId;
    if (projectId !== agent.projectId) {
      const attached = await ctx.db
        .select({ id: agentProjects.id })
        .from(agentProjects)
        .where(and(eq(agentProjects.agentId, agentId), eq(agentProjects.projectId, projectId)))
        .limit(1);
      if (attached.length === 0) {
        return reply.code(400).send({ error: "This agent isn't on that project's team" });
      }
    }

    const id = newId();
    const now = new Date();
    await ctx.db.insert(sessions).values({
      id,
      agentId,
      projectId,
      title: parsed.data.title ?? DEFAULT_TITLE,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return reply.code(201).send({ id });
  });

  instance.get("/api/sessions", async () => {
    const rows = await ctx.db
      .select({
        id: sessions.id,
        agentId: sessions.agentId,
        projectId: sessions.projectId,
        title: sessions.title,
        status: sessions.status,
        createdAt: sessions.createdAt,
        updatedAt: sessions.updatedAt,
        agentName: agents.name,
        projectName: projects.name,
      })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .innerJoin(projects, eq(sessions.projectId, projects.id))
      .orderBy(desc(sessions.updatedAt))
      .limit(200);
    return { sessions: rows };
  });

  instance.get("/api/projects/:projectId/sessions", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const rows = await ctx.db.select().from(sessions).where(eq(sessions.projectId, projectId));
    return { sessions: rows };
  });

  instance.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const session = sessionRows[0];
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const adapter = createPersistenceAdapter(ctx.db);
    const messages = await adapter.listMessages(id);
    const budget = computeBudget(messages);

    return {
      session,
      messages,
      budget,
      running: ctx.agentLoop.isRunning(id),
    };
  });

  instance.patch("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = renameSessionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!sessionRows[0]) return reply.code(404).send({ error: "Session not found" });

    await ctx.db
      .update(sessions)
      .set({ title: parsed.data.title, updatedAt: new Date() })
      .where(eq(sessions.id, id));
    return { ok: true };
  });

  instance.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (ctx.agentLoop.isRunning(id)) {
      return reply.code(409).send({ error: "Can't delete a session while it's running" });
    }
    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!sessionRows[0]) return reply.code(404).send({ error: "Session not found" });

    await ctx.db.delete(sessions).where(eq(sessions.id, id));
    return reply.code(204).send();
  });

  instance.post("/api/sessions/:id/compact", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (ctx.agentLoop.isRunning(id)) {
      return reply.code(409).send({ error: "Session is already running" });
    }

    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const session = sessionRows[0];
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const agentRows = await ctx.db.select().from(agents).where(eq(agents.id, session.agentId)).limit(1);
    const agent = agentRows[0];
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    try {
      const summary = await ctx.agentLoop.compact({
        sessionId: id,
        userId: request.user!.id,
        providerConfigId: agent.providerConfigId,
        model: agent.model,
      });
      return { message: summary };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  instance.post("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!parsed.data.text && parsed.data.images.length === 0) {
      return reply.code(400).send({ error: "Message must include text or at least one image" });
    }
    if (ctx.agentLoop.isRunning(id)) {
      return reply.code(409).send({ error: "Session is already running" });
    }

    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const session = sessionRows[0];
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const agentRows = await ctx.db.select().from(agents).where(eq(agents.id, session.agentId)).limit(1);
    const agent = agentRows[0];
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    const rootRows = await ctx.db
      .select()
      .from(projectRoots)
      .where(eq(projectRoots.projectId, session.projectId));
    const mainRoot = rootRows.find((r) => r.rootId === "main") ?? rootRows[0];
    if (!mainRoot) return reply.code(400).send({ error: "Project has no roots configured" });

    ctx.sandboxRegistry.register(id, { [mainRoot.rootId]: mainRoot.absolutePath });

    if (session.title === DEFAULT_TITLE && parsed.data.text) {
      await ctx.db
        .update(sessions)
        .set({ title: deriveTitle(parsed.data.text) })
        .where(eq(sessions.id, id));
    }

    const content: ContentBlock[] = [];
    if (parsed.data.text) content.push({ type: "text", text: parsed.data.text });
    for (const img of parsed.data.images) {
      content.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }

    ctx.agentLoop.start(
      {
        sessionId: id,
        agentId: agent.id,
        projectId: session.projectId,
        userId: request.user!.id,
        rootId: mainRoot.rootId,
        model: agent.model,
        providerConfigId: agent.providerConfigId,
        systemPrompt: await buildSystemPrompt(ctx.db, agent),
      },
      content,
    );

    return reply.code(202).send({ ok: true });
  });
  });
}
