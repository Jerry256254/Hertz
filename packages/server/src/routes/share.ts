import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { newId } from "../db/client.js";
import { agents, projects, sessions, sharedChats } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";
import { hasProjectAccess } from "../auth/project-access.js";
import { createPersistenceAdapter } from "../persistence/persistence-adapter.js";

/**
 * Public share links (grok.com/share style): the owner publishes a read-only
 * transcript snapshot under an unguessable URL; anyone with the link can read
 * it without logging in. Revoking deletes the link instantly.
 */
export function registerShareRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    /** Create (or return the existing) share link for a session. */
    instance.post("/api/sessions/:id/share", { preHandler: requireAuth }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      const session = sessionRows[0];
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, session.projectId))) {
        return reply.code(403).send({ error: "No access" });
      }
      const existing = await ctx.db.select().from(sharedChats).where(eq(sharedChats.sessionId, id)).limit(1);
      if (existing[0]) return { token: existing[0].token };
      const token = crypto.randomBytes(24).toString("base64url");
      await ctx.db.insert(sharedChats).values({
        id: newId(),
        sessionId: id,
        token,
        createdByUserId: request.user!.id,
        createdAt: new Date(),
      });
      return reply.code(201).send({ token });
    });

    instance.get("/api/sessions/:id/share", { preHandler: requireAuth }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      const session = sessionRows[0];
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, session.projectId))) {
        return reply.code(403).send({ error: "No access" });
      }
      const existing = await ctx.db.select().from(sharedChats).where(eq(sharedChats.sessionId, id)).limit(1);
      return { token: existing[0]?.token ?? null };
    });

    instance.delete("/api/sessions/:id/share", { preHandler: requireAuth }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      const session = sessionRows[0];
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, session.projectId))) {
        return reply.code(403).send({ error: "No access" });
      }
      await ctx.db.delete(sharedChats).where(eq(sharedChats.sessionId, id));
      return { ok: true };
    });

    /** Public transcript — deliberately outside requireAuth. Text + images only, no tool internals. */
    instance.get("/api/share/:token", async (request, reply) => {
      const { token } = request.params as { token: string };
      const rows = await ctx.db.select().from(sharedChats).where(eq(sharedChats.token, token)).limit(1);
      const share = rows[0];
      if (!share) return reply.code(404).send({ error: "Share link not found or revoked" });

      const sessionRows = await ctx.db.select().from(sessions).where(eq(sessions.id, share.sessionId)).limit(1);
      const session = sessionRows[0];
      if (!session) return reply.code(404).send({ error: "Session no longer exists" });

      const agentRows = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, session.agentId)).limit(1);
      const projectRows = await ctx.db.select({ name: projects.name }).from(projects).where(eq(projects.id, session.projectId)).limit(1);

      const adapter = createPersistenceAdapter(ctx.db);
      const history = await adapter.listMessages(session.id);
      const messages = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role,
          content: m.content.filter((b) => b.type === "text" || b.type === "image"),
          createdAt: m.createdAt,
        }))
        .filter((m) => m.content.length > 0);

      return {
        title: session.title,
        agentName: agentRows[0]?.name ?? "Agent",
        projectName: projectRows[0]?.name ?? null,
        sharedAt: share.createdAt,
        messages,
      };
    });
  });
}
