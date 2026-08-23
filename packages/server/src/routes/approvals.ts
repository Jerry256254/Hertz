import type { FastifyInstance } from "fastify";
import { aliasedTable, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agents, approvals, projectMembers, projects, sessions, users } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";
import { decideApproval } from "../tools/approval-tools.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";

const decisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) });

export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    /** Approval inbox — pending first. Non-admins only see their projects' requests. */
    instance.get("/api/approvals", async (request) => {
      const user = request.user!;
      let rows = await ctx.db
        .select({
          approval: approvals,
          agentName: agents.name,
          projectName: projects.name,
          sessionTitle: sessions.title,
          decidedByEmail: users.email,
        })
        .from(approvals)
        .innerJoin(agents, eq(approvals.agentId, agents.id))
        .innerJoin(projects, eq(approvals.projectId, projects.id))
        .innerJoin(sessions, eq(approvals.sessionId, sessions.id))
        .leftJoin(users, eq(approvals.decidedByUserId, users.id))
        .orderBy(desc(approvals.createdAt))
        .limit(200);

      if (user.role !== "admin") {
        const memberships = await ctx.db
          .select({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(eq(projectMembers.userId, user.id));
        const allowed = new Set(memberships.map((m) => m.projectId));
        rows = rows.filter((r) => allowed.has(r.approval.projectId));
      }

      return {
        approvals: rows.map(({ approval, agentName, projectName, sessionTitle, decidedByEmail }) => ({
          ...approval,
          agentName,
          projectName,
          sessionTitle,
          decidedByEmail: decidedByEmail ?? null,
        })),
      };
    });

    /** Approve or reject; resumes the parked agent run with the verdict. */
    instance.post("/api/approvals/:id/decision", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = decisionSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const result = await decideApproval(ctx.db, id, parsed.data.decision, request.user!.id);
      if (!result) return reply.code(404).send({ error: "Pending approval not found" });

      // Resume the agent with the decision as the next inbound message.
      await ctx.agentLoop.appendInbound(result.sessionId, [
        {
          type: "text",
          text:
            parsed.data.decision === "approved"
              ? `[The user APPROVED your request "${result.summary}".] Proceed exactly as described.`
              : `[The user REJECTED your request "${result.summary}".] Do not perform it. Continue without it — propose an alternative only if it's essential to the task.`,
        },
      ]);
      const metaRows = await ctx.db.select({ metadata: sessions.metadata }).from(sessions).where(eq(sessions.id, result.sessionId)).limit(1);
      let meta: Record<string, unknown> = {};
      try {
        meta = metaRows[0]?.metadata ? (JSON.parse(metaRows[0].metadata) as Record<string, unknown>) : {};
      } catch {
        meta = {};
      }
      delete meta.pendingQuestion;
      delete meta.pendingApprovalId;
      await ctx.db
        .update(sessions)
        .set({ status: "active", metadata: JSON.stringify(meta), updatedAt: new Date() })
        .where(eq(sessions.id, result.sessionId));

      try {
        await enqueueAgentRun(ctx, { sessionId: result.sessionId, prePersisted: true }, { maxAttempts: 2 });
      } catch {
        // Session already running — appendInbound above will be picked up mid-run.
      }

      return { ok: true };
    });
  });
}
