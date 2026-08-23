import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import type { OrgToolDef } from "./org-tools.js";
import { approvals, sessions } from "../db/schema.js";

const requestSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe("One-line description of the action you want approved, e.g. 'Send the offer e-mail to Jan Novák'"),
  detail: z
    .string()
    .optional()
    .describe("Full context for the decision: exactly what would be done, to whom, with what content/parameters, and what happens if rejected"),
});

/**
 * Human-in-the-loop gate, Grok-Bot-style: the agent prepares the sensitive
 * action, then ASKS before executing. The request lands in the CEO's approval
 * inbox (WebUI, and later any connected chat channel); the session parks in
 * awaiting_input until it's decided, then resumes automatically with the
 * verdict — so "Mám poslat tento e-mail?" actually gates the sending.
 */
export function createApprovalTools(db: Database): OrgToolDef[] {
  const requestApproval: OrgToolDef = {
    name: "request_approval",
    description:
      "Ask the user (CEO) to approve a sensitive or hard-to-reverse action BEFORE doing it — sending e-mail/messages on their behalf, spending money, deleting or publishing content, contacting third parties, changing account settings. Prepare everything first, describe precisely what would happen, then call this and STOP; you'll be resumed automatically with their decision. Not for ordinary work decisions — only actions with real-world consequences.",
    inputSchema: requestSchema,
    async execute(rawInput, ctx) {
      const input = requestSchema.parse(rawInput);
      const projectId = ctx.actor.projectId;
      const sessionId = ctx.actor.sessionId;
      if (!projectId || !sessionId) {
        return { summary: "No project/session context — cannot file an approval request.", isError: true };
      }

      const id = newId();
      await db.insert(approvals).values({
        id,
        projectId,
        agentId: ctx.actor.actorId,
        sessionId,
        summary: input.summary,
        detail: input.detail ?? null,
        createdAt: new Date(),
      });

      // Link the pending approval on the session so the UI can deep-link from
      // the awaiting-input banner straight to the inbox item.
      const rows = await db.select({ metadata: sessions.metadata }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      let meta: Record<string, unknown> = {};
      try {
        meta = rows[0]?.metadata ? (JSON.parse(rows[0].metadata) as Record<string, unknown>) : {};
      } catch {
        meta = {};
      }
      await db
        .update(sessions)
        .set({
          metadata: JSON.stringify({
            ...meta,
            pendingQuestion: `Approval needed: ${input.summary}`,
            pendingApprovalId: id,
          }),
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));

      return {
        summary: `Approval request filed ("${input.summary}") and shown to the user. Waiting for their decision.`,
        awaitUser: { question: `Approval needed: ${input.summary}` },
      };
    },
  };

  return [requestApproval];
}

/** Resolves an approval and returns the session id whose run should resume (if any). */
export async function decideApproval(
  db: Database,
  approvalId: string,
  decision: "approved" | "rejected",
  userId: string,
): Promise<{ sessionId: string; summary: string } | undefined> {
  const rows = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending"))).limit(1);
  const approval = rows[0];
  if (!approval) return undefined;

  await db
    .update(approvals)
    .set({ status: decision, decidedByUserId: userId || null, decidedAt: new Date() })
    .where(eq(approvals.id, approvalId));

  return { sessionId: approval.sessionId, summary: approval.summary };
}
