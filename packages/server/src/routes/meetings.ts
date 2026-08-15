import type { FastifyInstance } from "fastify";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { AppContext } from "../context.js";
import { agents, meetingMessages, meetingParticipants, meetings } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";

const createMeetingSchema = z.object({
  title: z.string().min(1),
  participantAgentIds: z.array(z.string().min(1)).min(1),
});

const postMessageSchema = z.object({
  text: z.string().min(1),
});

export function registerMeetingRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.post("/api/projects/:projectId/meetings", async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const parsed = createMeetingSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const participantRows = await ctx.db
        .select()
        .from(agents)
        .where(inArray(agents.id, parsed.data.participantAgentIds));
      if (participantRows.some((a) => a.projectId !== projectId)) {
        return reply.code(400).send({ error: "All participants must belong to this project" });
      }
      if (participantRows.some((a) => a.approvalStatus !== "approved")) {
        return reply.code(400).send({ error: "All participants must be approved first" });
      }
      if (participantRows.some((a) => a.status === "terminated")) {
        return reply.code(400).send({ error: "A terminated agent can't join a meeting" });
      }

      const id = newId();
      const now = new Date();
      await ctx.db.insert(meetings).values({ id, projectId, title: parsed.data.title, status: "active", createdAt: now, updatedAt: now });
      await ctx.db.insert(meetingParticipants).values(
        parsed.data.participantAgentIds.map((agentId) => ({ id: newId(), meetingId: id, agentId })),
      );
      return reply.code(201).send({ id });
    });

    instance.get("/api/projects/:projectId/meetings", async (request) => {
      const { projectId } = request.params as { projectId: string };
      const rows = await ctx.db.select().from(meetings).where(eq(meetings.projectId, projectId));
      return { meetings: rows };
    });

    instance.get("/api/meetings/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const meetingRows = await ctx.db.select().from(meetings).where(eq(meetings.id, id)).limit(1);
      const meeting = meetingRows[0];
      if (!meeting) return reply.code(404).send({ error: "Meeting not found" });

      const participantRows = await ctx.db
        .select({ agent: agents })
        .from(meetingParticipants)
        .innerJoin(agents, eq(meetingParticipants.agentId, agents.id))
        .where(eq(meetingParticipants.meetingId, id));

      const messageRows = await ctx.db
        .select()
        .from(meetingMessages)
        .where(eq(meetingMessages.meetingId, id))
        .orderBy(asc(meetingMessages.createdAt));

      return {
        meeting,
        participants: participantRows.map((r) => r.agent),
        messages: messageRows.map((m) => ({ ...m, content: JSON.parse(m.content) as ContentBlock[] })),
        running: ctx.meetingOrchestrator.isRunning(id),
      };
    });

    instance.post("/api/meetings/:id/messages", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = postMessageSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (ctx.meetingOrchestrator.isRunning(id)) {
        return reply.code(409).send({ error: "This meeting's round is already in progress" });
      }

      const meetingRows = await ctx.db.select().from(meetings).where(eq(meetings.id, id)).limit(1);
      if (!meetingRows[0]) return reply.code(404).send({ error: "Meeting not found" });

      await ctx.meetingOrchestrator.appendUserMessage(id, parsed.data.text);
      ctx.meetingOrchestrator.startRound(id);
      return reply.code(202).send({ ok: true });
    });

    instance.delete("/api/meetings/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (ctx.meetingOrchestrator.isRunning(id)) {
        return reply.code(409).send({ error: "Can't delete a meeting while a round is in progress" });
      }
      const rows = await ctx.db.select({ id: meetings.id }).from(meetings).where(eq(meetings.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Meeting not found" });

      await ctx.db.delete(meetings).where(eq(meetings.id, id));
      return reply.code(204).send();
    });
  });
}
