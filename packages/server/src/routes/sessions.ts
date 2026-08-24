import type { FastifyInstance } from "fastify";
import { aliasedTable, and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ContentBlock } from "@kuclab-hertz/providers";
import { computeBudget } from "@kuclab-hertz/core";
import type { AppContext } from "../context.js";
import { agentProjects, agents, projectRoots, projects, sessionParticipants, sessions } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { createPersistenceAdapter } from "../persistence/persistence-adapter.js";
import { listConversations, pickConversationActor } from "../conversations.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";
import { createGroupSession, listGroupParticipants } from "../groups.js";
import { hasProjectAccess } from "../auth/project-access.js";

const DEFAULT_TITLE = "New chat";

const createSessionSchema = z.object({
  title: z.string().optional(),
  /** Which project this chat is about. Defaults to the agent's home project — required when the agent has been attached to more than one. */
  projectId: z.string().optional(),
});

const renameSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const sendMessageSchema = z.object({
  text: z.string().optional(),
  images: z
    .array(z.object({ mimeType: z.string(), data: z.string() }))
    .optional()
    .default([]),
});

const answerSchema = z.object({
  text: z.string().min(1).max(20_000),
});

const createGroupSchema = z.object({
  title: z.string().min(1).max(120),
  agentIds: z.array(z.string().min(1)).min(1).max(12),
});

function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/** Enqueues a fresh run on a session (user message already persisted, or prePersisted for tool-triggered runs). The handler in run-jobs.ts rebuilds everything else from the DB. */
async function startSessionRun(
  ctx: AppContext,
  session: { id: string; projectId: string; agentId: string; kind: string; mode: string | null },
  _agent: { id: string; model: string; providerConfigId: string; systemPrompt: string | null },
  content: ContentBlock[],
  opts: { userId: string; prePersisted?: boolean; conversationPeerName?: string; excludeTools?: string[]; respondAsAgentId?: string },
): Promise<void> {
  const mode = (session.mode === "plan" || session.mode === "autonomous" ? session.mode : "auto") as
    | "plan"
    | "auto"
    | "autonomous";

  await enqueueAgentRun(ctx, {
    sessionId: session.id,
    userId: opts.userId,
    mode,
    excludeTools: opts.excludeTools,
    prePersisted: opts.prePersisted,
    userMessage: content,
    conversationPeerName: opts.conversationPeerName,
    respondAsAgentId: opts.respondAsAgentId,
  });
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
    if (agent.approvalStatus !== "approved") {
      return reply.code(400).send({ error: `${agent.name} is still awaiting approval` });
    }
    if (agent.status === "terminated") {
      return reply.code(400).send({ error: `${agent.name} has been terminated` });
    }

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
    const peer = aliasedTable(agents, "peer");
    const rows = await ctx.db
      .select({
        id: sessions.id,
        agentId: sessions.agentId,
        projectId: sessions.projectId,
        title: sessions.title,
        kind: sessions.kind,
        peerAgentId: sessions.peerAgentId,
        status: sessions.status,
        createdAt: sessions.createdAt,
        updatedAt: sessions.updatedAt,
        agentName: agents.name,
        peerAgentName: peer.name,
        projectName: projects.name,
      })
      .from(sessions)
      .innerJoin(agents, eq(sessions.agentId, agents.id))
      .leftJoin(peer, eq(sessions.peerAgentId, peer.id))
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

  /** Messenger-style group chat: multiple bots share one thread with you. */
  instance.post("/api/projects/:projectId/group-chats", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) {
      return reply.code(403).send({ error: "No access to this project" });
    }

    const sessionId = await createGroupSession(ctx, { projectId, title: parsed.data.title, agentIds: parsed.data.agentIds });
    return reply.code(201).send({ id: sessionId });
  });

  /** Direct agent ↔ agent chats — a conversation is a session with kind = "conversation", so this is a thin list wrapper. */
  instance.get("/api/projects/:projectId/conversations", async (request) => {
    const { projectId } = request.params as { projectId: string };
    return { conversations: await listConversations(ctx.db, projectId) };
  });

  instance.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const session = sessionRows[0];
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const adapter = createPersistenceAdapter(ctx.db);
    const messages = await adapter.listMessages(id);
    const budget = computeBudget(messages);

    const agent = session.agentId
      ? (await ctx.db.select({ id: agents.id, name: agents.name, role: agents.role, mascot: agents.mascot }).from(agents).where(eq(agents.id, session.agentId)).limit(1))[0]
      : undefined;
    const peerAgent = session.peerAgentId
      ? (await ctx.db.select({ id: agents.id, name: agents.name, role: agents.role, mascot: agents.mascot }).from(agents).where(eq(agents.id, session.peerAgentId)).limit(1))[0]
      : undefined;

    const participants = session.kind === "group"
      ? await ctx.db
          .select({ id: agents.id, name: agents.name, role: agents.role, mascot: agents.mascot })
          .from(sessionParticipants)
          .innerJoin(agents, eq(sessionParticipants.agentId, agents.id))
          .where(eq(sessionParticipants.sessionId, id))
      : [];

    return {
      session,
      messages,
      budget,
      running: ctx.agentLoop.isRunning(id),
      paused: ctx.agentLoop.isPaused(id),
      pendingQuestion: session.metadata ? (JSON.parse(session.metadata).pendingQuestion as string | undefined) ?? null : null,
      pendingQuestionAgentId: session.metadata ? (JSON.parse(session.metadata).pendingQuestionAgentId as string | undefined) ?? null : null,
      pendingTakeover: session.metadata
        ? ((JSON.parse(session.metadata).pendingTakeover as { reason?: string } | undefined) ?? null)
        : null,
      agent,
      peerAgent,
      participants,
    };
  });

  instance.post("/api/sessions/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await ctx.agentLoop.pause(id);
    if (!ok) return reply.code(409).send({ error: "Session isn't running" });
    return { ok: true };
  });

  instance.post("/api/sessions/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await ctx.agentLoop.resume(id))) {
      // Not live in memory — either not running, or paused before a server
      // restart. Durable resume: a persisted 'paused' session restarts via the
      // queue, which is what makes pause survive reboots.
      const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      const session = sessionRows[0];
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (session.status !== "paused") return reply.code(409).send({ error: "Session isn't running" });
      await ctx.db.update(sessions).set({ status: "active", updatedAt: new Date() }).where(eq(sessions.id, id));
      await enqueueAgentRun(ctx, { sessionId: id, prePersisted: true }, { maxAttempts: 2 });
    }
    return { ok: true };
  });

  /** Hard-stops the current run: aborts the in-flight model call and finalizes the session. */
  instance.post("/api/sessions/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ctx.agentLoop.isRunning(id)) return reply.code(409).send({ error: "Session isn't running" });
    ctx.agentLoop.stop(id);
    return { ok: true };
  });

  instance.patch("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = renameSessionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!sessionRows[0]) return reply.code(404).send({ error: "Session not found" });

    await ctx.db
      .update(sessions)
      .set({
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        updatedAt: new Date(),
      })
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

    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const session = sessionRows[0];
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const content: ContentBlock[] = [];
    if (parsed.data.text) content.push({ type: "text", text: parsed.data.text });
    for (const img of parsed.data.images) {
      content.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }

    // A message sent while the agent is mid-work is injected into the run: the
    // loop notices it between turns and answers it without stopping what it's
    // doing (pause takes effect between turns too).
    if (ctx.agentLoop.isRunning(id)) {
      await ctx.agentLoop.appendInbound(id, content);
      return reply.code(202).send({ ok: true });
    }

    // Group chats: persist the message, then one job fans the turn out across
    // participants (@mention someone by name to narrow who answers).
    if (session.kind === "group") {
      await ctx.agentLoop.appendInbound(id, content);
      await enqueueAgentRun(ctx, { sessionId: id, userId: request.user!.id, prePersisted: true }, { maxAttempts: 2 });
      return reply.code(202).send({ ok: true });
    }

    // Pick the agent that answers: direct conversations go to whoever didn't
    // speak last, with message_employee and ask_user withheld so replies stay
    // in-thread instead of re-sending to the peer / stopping for user input.
    let agent = session.agentId
      ? (await ctx.db.select().from(agents).where(eq(agents.id, session.agentId)).limit(1))[0]
      : undefined;
    let peerAgent: (typeof agents.$inferSelect) | undefined;
    let conversationPeerName: string | undefined;
    let excludeTools: string[] | undefined;

    if (session.kind === "conversation") {
      const actorId = await pickConversationActor(ctx.db, session);
      const actorRows = await ctx.db.select().from(agents).where(eq(agents.id, actorId)).limit(1);
      agent = actorRows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      const peerId = session.agentId === actorId ? session.peerAgentId : session.agentId;
      peerAgent = peerId
        ? (await ctx.db.select().from(agents).where(eq(agents.id, peerId)).limit(1))[0]
        : undefined;
      conversationPeerName = peerAgent?.name ?? "a colleague";
      excludeTools = ["message_employee", "ask_user"];
    } else {
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      // New message supersedes any pending ask_user question.
      if (session.status === "awaiting_input") {
        await ctx.db
          .update(sessions)
          .set({ status: "active", metadata: null, updatedAt: new Date() })
          .where(eq(sessions.id, id));
      }
    }

    if (session.kind !== "conversation" && session.title === DEFAULT_TITLE && parsed.data.text) {
      await ctx.db
        .update(sessions)
        .set({ title: deriveTitle(parsed.data.text) })
        .where(eq(sessions.id, id));
    }

    try {
      await startSessionRun(ctx, session, agent, content, {
        userId: request.user!.id,
        conversationPeerName,
        excludeTools,
        respondAsAgentId: session.kind === "conversation" ? agent.id : undefined,
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    return reply.code(202).send({ ok: true });
  });

  /** Answers an ask_user question: the answer lands as a user message and the agent's run continues. */
  instance.post("/api/sessions/:id/answer", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = answerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const session = sessionRows[0];
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.status !== "awaiting_input") {
      return reply.code(409).send({ error: "The agent isn't waiting for an answer right now" });
    }
    if (ctx.agentLoop.isRunning(id)) {
      return reply.code(409).send({ error: "The agent is still working — wait for it to ask" });
    }

    await ctx.agentLoop.appendInbound(id, [{ type: "text", text: parsed.data.text }]);

    // Remember which agent asked (group chats) so only it resumes; clear the gate.
    let pendingQuestionAgentId: string | undefined;
    if (session.metadata) {
      try {
        const meta = JSON.parse(session.metadata) as { pendingQuestionAgentId?: string };
        pendingQuestionAgentId = meta.pendingQuestionAgentId;
      } catch {
        /* ignore */
      }
    }
    await ctx.db
      .update(sessions)
      .set({ status: "active", metadata: null, updatedAt: new Date() })
      .where(eq(sessions.id, id));

    try {
      await enqueueAgentRun(
        ctx,
        {
          sessionId: id,
          userId: request.user!.id,
          prePersisted: true,
          ...(session.kind === "group" && pendingQuestionAgentId ? { forceAgentId: pendingQuestionAgentId } : {}),
        },
        { maxAttempts: 2 },
      );
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return reply.code(202).send({ ok: true });
  });
  });
}
