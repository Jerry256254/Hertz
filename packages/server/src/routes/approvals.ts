import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { sendZodError } from "../validation/czech-errors.js";
import type { AppContext } from "../context.js";
import { agents, approvals, projectMembers, projects, sessions, users } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";
import { decideApproval } from "../tools/approval-tools.js";
import { parseMcpOpPayload } from "../mcp/tool-policy.js";
import { resolveVaultUseApproval } from "../tools/vault-tools.js";
import { hasProjectAccess } from "../auth/project-access.js";
import {
  executeHostAccessOp,
  formatHostAccessExecutedInbound,
  formatHostAccessRejectedInbound,
  parseHostAccessPayload,
} from "../tools/host-access-tools.js";
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
      if (!parsed.success) return sendZodError(reply, parsed.error);

      // Authorization: only someone with access to the approval's project may decide it.
      const pending = await ctx.db
        .select({ projectId: approvals.projectId, status: approvals.status })
        .from(approvals)
        .where(eq(approvals.id, id))
        .limit(1);
      if (!pending[0] || pending[0].status !== "pending") return reply.code(404).send({ error: "Pending approval not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, pending[0].projectId)))
        return reply.code(403).send({ error: "No access to this project" });

      const result = await decideApproval(ctx.db, id, parsed.data.decision, request.user!.id);
      if (!result) return reply.code(404).send({ error: "Pending approval not found" });

      // Host-access approvals carry a machine-readable op the SERVER executes
      // on approve (user-actuated host touch); generic approvals just resume.
      let inboundText: string;
      if (result.kind === "host_access") {
        const payload = parseHostAccessPayload(result.payload);
        if (!payload) {
          inboundText = `[Your host-access request "${result.summary}" had an unreadable payload — the server could not execute it. Continue inside your own files.]`;
        } else if (parsed.data.decision === "rejected") {
          await ctx.audit.record({
            actorId: request.user!.id,
            actorType: "user",
            sessionId: result.sessionId,
            projectId: result.projectId,
            action: "host_access.rejected",
            target: payload.hostPath,
            targetType: "host_path",
            result: "denied",
            detail: { op: payload.op, hostPath: payload.hostPath, approvalId: id },
          });
          inboundText = formatHostAccessRejectedInbound(payload);
        } else {
          await ctx.audit.record({
            actorId: request.user!.id,
            actorType: "user",
            sessionId: result.sessionId,
            projectId: result.projectId,
            action: "host_access.approved",
            target: payload.hostPath,
            targetType: "host_path",
            result: "allowed",
            detail: { op: payload.op, hostPath: payload.hostPath, approvalId: id },
          });
          const opResult = await executeHostAccessOp(payload);
          await ctx.db.update(approvals).set({ result: JSON.stringify(opResult) }).where(eq(approvals.id, id));
          await ctx.audit.record({
            actorId: request.user!.id,
            actorType: "user",
            sessionId: result.sessionId,
            projectId: result.projectId,
            action: "host_access.executed",
            target: payload.hostPath,
            targetType: "host_path",
            result: opResult.ok ? "allowed" : "error",
            detail: { op: payload.op, hostPath: payload.hostPath, ok: opResult.ok, bytes: opResult.bytes, error: opResult.error },
          });
          inboundText = formatHostAccessExecutedInbound(payload, opResult);
        }
      } else if (result.kind === "mcp_op") {
        // Sensitive MCP ops (sending e-mail, deleting, overwriting…): on
        // approve the SERVER executes the call itself (the agent must never
        // run it directly); on reject nothing runs.
        const mcpPayload = parseMcpOpPayload(result.payload);
        if (!mcpPayload) {
          inboundText = `[Citlivá operace "${result.summary}" měla nečitelná data — server ji nemohl provést. Pokračuj bez ní.]`;
        } else if (parsed.data.decision === "rejected") {
          await ctx.audit.record({
            actorId: request.user!.id,
            actorType: "user",
            sessionId: result.sessionId,
            projectId: result.projectId,
            action: "mcp_op.rejected",
            target: `${mcpPayload.serverName}:${mcpPayload.toolName}`,
            targetType: "mcp_tool",
            result: "denied",
            detail: { serverId: mcpPayload.serverId, toolName: mcpPayload.toolName, approvalId: id },
          });
          inboundText = `[Uživatel ZAMÍTL citlivou operaci "${result.summary}".] Neprováděj ji a nepokoušej se ji obejít jinou cestou. Pokračuj bez ní.`;
        } else {
          await ctx.audit.record({
            actorId: request.user!.id,
            actorType: "user",
            sessionId: result.sessionId,
            projectId: result.projectId,
            action: "mcp_op.approved",
            target: `${mcpPayload.serverName}:${mcpPayload.toolName}`,
            targetType: "mcp_tool",
            result: "allowed",
            detail: { serverId: mcpPayload.serverId, toolName: mcpPayload.toolName, approvalId: id },
          });
          const mcpResult = await ctx.mcpRegistry.executeApprovedOp(mcpPayload.serverId, mcpPayload.toolName, mcpPayload.input);
          await ctx.db.update(approvals).set({ result: JSON.stringify({ summary: mcpResult.summary, isError: !!mcpResult.isError }) }).where(eq(approvals.id, id));
          await ctx.audit.record({
            actorId: request.user!.id,
            actorType: "user",
            sessionId: result.sessionId,
            projectId: result.projectId,
            action: "mcp_op.executed",
            target: `${mcpPayload.serverName}:${mcpPayload.toolName}`,
            targetType: "mcp_tool",
            result: mcpResult.isError ? "error" : "allowed",
            detail: { serverId: mcpPayload.serverId, toolName: mcpPayload.toolName, approvalId: id },
          });
          inboundText = mcpResult.isError
            ? `[Uživatel SCHVÁLIL citlivou operaci "${result.summary}", ale její provedení selhalo: ${mcpResult.summary}] Pokračuj bez ní, případně navrhni alternativu.`
            : `[Uživatel SCHVÁLIL citlivou operaci "${result.summary}" — server ji provedl s tímto výsledkem:\n${mcpResult.summary}] Pokračuj v úkolu s tímto výsledkem.`;
        }
      } else if (result.kind === "vault_use") {
        // Vault-use approvals are machine-readable too: on approve the server
        // decrypts the secret into a single-use in-memory grant (never into
        // the DB, logs, or the agent's chat history); on reject nothing is
        // issued and the secret stays sealed.
        inboundText = await resolveVaultUseApproval(ctx.db, ctx.masterKey, {
          approvalId: id,
          sessionId: result.sessionId,
          summary: result.summary,
          payload: result.payload,
          decision: parsed.data.decision,
          decidedByUserId: request.user!.id,
        });
      } else {
        inboundText =
          parsed.data.decision === "approved"
            ? `[The user APPROVED your request "${result.summary}".] Proceed exactly as described.`
            : `[The user REJECTED your request "${result.summary}".] Do not perform it. Continue without it — propose an alternative only if it's essential to the task.`;
      }

      // Resume the agent with the decision as the next inbound message.
      await ctx.agentLoop.appendInbound(result.sessionId, [
        {
          type: "text",
          text: inboundText,
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

      // Resume the run only if the session isn't already being worked on —
      // inbound above is persisted, so a running loop picks it up mid-run.
      if (!ctx.agentLoop.isRunning(result.sessionId)) {
        await enqueueAgentRun(ctx, { sessionId: result.sessionId, prePersisted: true }, { maxAttempts: 2 });
      }

      return { ok: true };
    });
  });
}
