import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ContentBlock } from "@kuclab-hertz/providers";
import { computeBudget } from "@kuclab-hertz/core";
import type { AppContext } from "../context.js";
import { agents, projectRoots, sessions } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { createPersistenceAdapter } from "../persistence/persistence-adapter.js";

const createSessionSchema = z.object({
  title: z.string().optional(),
});

const sendMessageSchema = z.object({
  text: z.string().optional(),
  images: z
    .array(z.object({ mimeType: z.string(), data: z.string() }))
    .optional()
    .default([]),
});

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

    const id = newId();
    const now = new Date();
    await ctx.db.insert(sessions).values({
      id,
      agentId,
      projectId: agent.projectId,
      title: parsed.data.title ?? "New session",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return reply.code(201).send({ id });
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
        systemPrompt: agent.systemPrompt ?? "",
      },
      content,
    );

    return reply.code(202).send({ ok: true });
  });
  });
}
