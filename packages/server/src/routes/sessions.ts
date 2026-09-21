import type { FastifyInstance } from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ContentBlock } from "@kuclab-hertz/providers";
import { computeBudget } from "@kuclab-hertz/core";
import type { AppContext } from "../context.js";
import { agents, approvals, channelBindings, messages, projects, sessions } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { createPersistenceAdapter } from "../persistence/persistence-adapter.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";
import { accessibleProjectIds, hasProjectAccess } from "../auth/project-access.js";
import { checkBudget } from "../usage/quota.js";

function clearPendingMetadata(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    delete meta.pendingQuestion;
    delete meta.pendingQuestionAgentId;
    delete meta.pendingTakeover;
    const keys = Object.keys(meta);
    return keys.length === 0 ? null : JSON.stringify(meta);
  } catch { return null; }
}


const DEFAULT_TITLE = "New chat";

const createSessionSchema = z.object({
  title: z.string().optional(),
  /** Which project this chat works in. Defaults to the agent's home project. */
  projectId: z.string().optional(),
});

const renameSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const sendMessageSchema = z.object({
  text: z.string().max(100_000).optional(),
  images: z
    .array(z.object({ mimeType: z.string(), data: z.string() }))
    .optional()
    .default([]),
  /** Small text-based documents (txt/md/csv/json) as base64 — inlined into the message as text. */
  files: z
    .array(z.object({ name: z.string().max(120), mimeType: z.string(), data: z.string() }))
    .optional()
    .default([]),
});

const answerSchema = z.object({
  text: z.string().min(1).max(20_000),
});

function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/** Enqueues a fresh run on a session (user message already persisted, or prePersisted for tool-triggered runs). The handler in run-jobs.ts rebuilds everything else from the DB. */
async function startSessionRun(
  ctx: AppContext,
  session: { id: string; projectId: string; agentId: string; mode: string | null },
  _agent: { id: string; model: string; providerConfigId: string; systemPrompt: string | null },
  content: ContentBlock[],
  opts: { userId: string; prePersisted?: boolean; excludeTools?: string[] },
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

    const projectId = parsed.data.projectId ?? agent.projectId;
    // The session belongs to the agent's own project — no cross-project chats.
    if (projectId !== agent.projectId) return reply.code(400).send({ error: "Project does not match the agent" });
    if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) {
      return reply.code(403).send({ error: "No access to this project" });
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

  instance.get("/api/sessions", async (request) => {
    // Non-admin users only see sessions in projects they can access.
    // Filter in SQL, not after .limit(200) — otherwise a non-admin could get
    // an empty page even though they have sessions further down the list.
    const accessible = request.user!.role === "admin" ? ("all" as const) : await accessibleProjectIds(ctx.db, request.user!);
    if (accessible !== "all" && accessible.size === 0) return { sessions: [] };
    const base = ctx.db
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
      .innerJoin(projects, eq(sessions.projectId, projects.id));
    const rows =
      accessible === "all"
        ? await base.orderBy(desc(sessions.updatedAt)).limit(200)
        : await base
            .where(inArray(sessions.projectId, [...accessible] as string[]))
            .orderBy(desc(sessions.updatedAt))
            .limit(200);
    return { sessions: rows };
  });

  instance.get("/api/projects/:projectId/sessions", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) return reply.code(403).send({ error: "No access to this project" });
    const rows = await ctx.db.select().from(sessions).where(eq(sessions.projectId, projectId));
    return { sessions: rows };
  });

  instance.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const session = sessionRows[0];
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!(await hasProjectAccess(ctx.db, request.user!, session.projectId))) return reply.code(403).send({ error: "No access to this project" });

    const adapter = createPersistenceAdapter(ctx.db);
    const messages = await adapter.listMessages(id);
    const budget = computeBudget(messages);

    const agent = session.agentId
      ? (await ctx.db.select({ id: agents.id, name: agents.name, mascot: agents.mascot, avatar: agents.avatar }).from(agents).where(eq(agents.id, session.agentId)).limit(1))[0]
      : undefined;

    return {
      session,
      messages,
      budget,
      running: ctx.agentLoop.isRunning(id),
      paused: ctx.agentLoop.isPaused(id),
      pendingQuestion: (() => { try { return session.metadata ? (JSON.parse(session.metadata).pendingQuestion as string | undefined) ?? null : null; } catch { return null; } })(),
      pendingQuestionAgentId: (() => { try { return session.metadata ? (JSON.parse(session.metadata).pendingQuestionAgentId as string | undefined) ?? null : null; } catch { return null; } })(),
      pendingTakeover: (() => { try { return session.metadata ? ((JSON.parse(session.metadata).pendingTakeover as { reason?: string } | undefined) ?? null) : null; } catch { return null; } })(),
      agent,
    };
  });

  instance.post("/api/sessions/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessRows = await ctx.db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, id)).limit(1);
    if (sessRows[0] && !(await hasProjectAccess(ctx.db, request.user!, sessRows[0].projectId))) return reply.code(403).send({ error: "No access" });
    const ok = await ctx.agentLoop.pause(id);
    if (!ok) return reply.code(409).send({ error: "Session isn't running" });
    return { ok: true };
  });

  instance.post("/api/sessions/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const rSessRows = await ctx.db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, id)).limit(1);
    if (rSessRows[0] && !(await hasProjectAccess(ctx.db, request.user!, rSessRows[0].projectId))) return reply.code(403).send({ error: "No access" });
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
    const sRows = await ctx.db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, id)).limit(1);
    if (sRows[0] && !(await hasProjectAccess(ctx.db, request.user!, sRows[0].projectId))) return reply.code(403).send({ error: "No access" });
    if (!ctx.agentLoop.isRunning(id)) return reply.code(409).send({ error: "Session isn't running" });
    ctx.agentLoop.stop(id);
    return { ok: true };
  });

  instance.patch("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const pSess = await ctx.db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, id)).limit(1);
    if (pSess[0] && !(await hasProjectAccess(ctx.db, request.user!, pSess[0].projectId))) return reply.code(403).send({ error: "No access" });
    const parsed = renameSessionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!sessionRows[0]) return reply.code(404).send({ error: "Session not found" });

    const trimmedTitle = parsed.data.title?.trim();
    if (trimmedTitle !== undefined && trimmedTitle.length === 0) return reply.code(400).send({ error: "Title cannot be empty" });
    await ctx.db
      .update(sessions)
      .set({
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, id));
    return { ok: true };
  });

  /** /clear — wipes this chat's messages only. Memory, skills, notes stay; the session itself survives. */
  instance.post("/api/sessions/:id/clear", async (request, reply) => {
    const { id } = request.params as { id: string };
    const cSess = await ctx.db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!cSess[0]) return reply.code(404).send({ error: "Session not found" });
    if (!(await hasProjectAccess(ctx.db, request.user!, cSess[0].projectId))) return reply.code(403).send({ error: "No access" });
    if (ctx.agentLoop.isRunning(id)) {
      return reply.code(409).send({ error: "Stop the agent before clearing this chat." });
    }
    await ctx.db.delete(messages).where(eq(messages.sessionId, id));
    await ctx.db.update(sessions).set({ status: "active", metadata: null, updatedAt: new Date() }).where(eq(sessions.id, id));
    return { ok: true };
  });

  instance.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const dSess = await ctx.db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, id)).limit(1);
    if (dSess[0] && !(await hasProjectAccess(ctx.db, request.user!, dSess[0].projectId))) return reply.code(403).send({ error: "No access" });
    if (ctx.agentLoop.isRunning(id)) {
      return reply.code(409).send({ error: "Can't delete a session while it's running" });
    }
    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!sessionRows[0]) return reply.code(404).send({ error: "Session not found" });

    // FK cascades are declared in the schema but not enforced
    // (PRAGMA foreign_keys is off) — clean up dependents manually so no
    // orphan rows are left behind.
    await ctx.db.delete(messages).where(eq(messages.sessionId, id));
    await ctx.db.delete(approvals).where(eq(approvals.sessionId, id));
    await ctx.db.delete(channelBindings).where(eq(channelBindings.sessionId, id));
    await ctx.db.delete(sessions).where(eq(sessions.id, id));
    return reply.code(204).send();
  });

  instance.post("/api/sessions/:id/compact", async (request, reply) => {
    const { id } = request.params as { id: string };
    const cSess = await ctx.db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, id)).limit(1);
    if (cSess[0] && !(await hasProjectAccess(ctx.db, request.user!, cSess[0].projectId))) return reply.code(403).send({ error: "No access" });
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
    if (!parsed.data.text && parsed.data.images.length === 0 && parsed.data.files.length === 0) {
      return reply.code(400).send({ error: "Message must include text, an image, or a file" });
    }

    const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    const session = sessionRows[0];
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!(await hasProjectAccess(ctx.db, request.user!, session.projectId))) return reply.code(403).send({ error: "No access" });
    // run-jobs would silently drop the job — fail loudly instead of swallowing the message.
    if (session.status === "archived") return reply.code(410).send({ error: "This chat is archived" });

    const budget = await checkBudget(ctx.db, request.user!.id);
    if (!budget.allowed) {
      return reply.code(402).send({
        error: `Monthly AI budget of $${budget.budget!.toFixed(2)} exhausted (spent $${budget.spend.toFixed(2)}). Ask an admin to raise it.`,
      });
    }

    if (parsed.data.images.length > 5) return reply.code(400).send({ error: "At most 5 images per message" });
    for (const img of parsed.data.images) {
      if (img.data.length > 5_000_000) return reply.code(400).send({ error: "Image too large (max ~3.5 MB)" });
      if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(img.mimeType)) return reply.code(400).send({ error: `Unsupported image type: ${img.mimeType}` });
    }
    if (parsed.data.files.length > 5) return reply.code(400).send({ error: "At most 5 files per message" });
    for (const file of parsed.data.files) {
      if (file.data.length > 400_000) return reply.code(400).send({ error: `File ${file.name} too large (max ~300 KB of text)` });
      if (!/^(text\/|application\/(json|csv|x-javascript)|.*(csv|json|markdown)$)/.test(file.mimeType) && !/\.(txt|md|markdown|csv|json|ts|js|py|log)$/i.test(file.name)) {
        return reply.code(400).send({ error: `Only text documents are supported (${file.name}); PDFs and binaries can't be read yet` });
      }
    }

    const content: ContentBlock[] = [];
    if (parsed.data.text) content.push({ type: "text", text: parsed.data.text });
    for (const img of parsed.data.images) {
      content.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }
    for (const file of parsed.data.files) {
      let decoded = "";
      try {
        decoded = Buffer.from(file.data, "base64").toString("utf8").slice(0, 60_000);
      } catch {
        return reply.code(400).send({ error: `Could not decode ${file.name}` });
      }
      content.push({ type: "text", text: `Příloha ${file.name}:\n\`\`\`\n${decoded}\n\`\`\`` });
    }

    // A message sent while the agent is mid-work is injected into the run: the
    // loop notices it between turns and answers it without stopping what it's
    // doing (pause takes effect between turns too).
    if (ctx.agentLoop.isRunning(id)) {
      await ctx.agentLoop.appendInbound(id, content);
      return reply.code(202).send({ ok: true });
    }

    const agent = session.agentId
      ? (await ctx.db.select().from(agents).where(eq(agents.id, session.agentId)).limit(1))[0]
      : undefined;
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    // New message supersedes any pending ask_user question — preserve other metadata (todos etc).
    if (session.status === "awaiting_input") {
      const cleared = clearPendingMetadata(session.metadata);
      await ctx.db
        .update(sessions)
        .set({ status: "active", metadata: cleared, updatedAt: new Date() })
        .where(eq(sessions.id, id));
    }

    if (session.title === DEFAULT_TITLE && parsed.data.text) {
      await ctx.db
        .update(sessions)
        .set({ title: deriveTitle(parsed.data.text) })
        .where(eq(sessions.id, id));
    }

    try {
      await startSessionRun(ctx, session, agent, content, {
        userId: request.user!.id,
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
    if (!(await hasProjectAccess(ctx.db, request.user!, session.projectId))) return reply.code(403).send({ error: "No access" });
    if (session.status !== "awaiting_input") {
      return reply.code(409).send({ error: "The agent isn't waiting for an answer right now" });
    }
    if (ctx.agentLoop.isRunning(id)) {
      return reply.code(409).send({ error: "The agent is still working — wait for it to ask" });
    }

    await ctx.agentLoop.appendInbound(id, [{ type: "text", text: parsed.data.text }]);

    const clearedAnswer = clearPendingMetadata(session.metadata);
    await ctx.db
      .update(sessions)
      .set({ status: "active", metadata: clearedAnswer, updatedAt: new Date() })
      .where(eq(sessions.id, id));

    // isRunning was checked above (409) — enqueue directly.
    try {
      await enqueueAgentRun(
        ctx,
        {
          sessionId: id,
          userId: request.user!.id,
          prePersisted: true,
        },
        { maxAttempts: 2 },
      );
    } catch (err) {
      // Only real enqueue failures (DB down etc.) land here.
      return reply.code(500).send({ error: `Could not resume the agent: ${(err as Error).message}` });
    }
    return reply.code(202).send({ ok: true });
  });
  });
}
