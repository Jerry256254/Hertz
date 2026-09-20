import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import type { AgentToolDef } from "./tool-def.js";
import { approvals, channelBindings, messages, routines, sessions } from "../db/schema.js";

/**
 * The agent's view of its own world: recent chats, pending approvals, and
 * scheduled routines. Read-only — these exist so "what did I do yesterday /
 * what's waiting / what's planned" is one tool call, not a filesystem safari.
 */
export function createContextTools(db: Database): AgentToolDef[] {
  const listChats: AgentToolDef = {
    name: "list_my_chats",
    description:
      "List your recent chats (title + last activity + how many messages). Use when the user asks what you did, worked on, or talked about — then read the details from your memory or the chat itself.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(30).optional().describe("How many chats to list (default 10)"),
    }),
    async execute(rawInput, ctx) {
      const input = z.object({ limit: z.number().int().min(1).max(30).optional() }).parse(rawInput ?? {});
      const limit = input.limit ?? 10;
      const rows = await db
        .select({ id: sessions.id, title: sessions.title, status: sessions.status, updatedAt: sessions.updatedAt })
        .from(sessions)
        .where(eq(sessions.agentId, ctx.actor.actorId))
        .orderBy(desc(sessions.updatedAt))
        .limit(limit);
      if (rows.length === 0) return { summary: "(no chats yet)" };
      const boundRows = await db.select({ sessionId: channelBindings.sessionId }).from(channelBindings);
      const bound = new Set(boundRows.map((b) => b.sessionId));
      const lines: string[] = [];
      for (const r of rows) {
        const count = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.sessionId, r.id))
          .limit(1000);
        lines.push(
          `- "${r.title}" — ${count.length} messages, last activity ${r.updatedAt.toISOString()}${bound.has(r.id) ? " [channel chat]" : ""}${r.status !== "active" ? ` [${r.status}]` : ""}`,
        );
      }
      return { summary: lines.join("\n") };
    },
  };

  const listApprovals: AgentToolDef = {
    name: "list_pending_approvals",
    description:
      "List approval requests waiting for the user's decision (and recent decided ones). Use when asked what's pending, and before re-asking for something already approved or rejected.",
    inputSchema: z.object({
      includeDecided: z.boolean().optional().describe("Also include recently approved/rejected requests (default false)"),
      limit: z.number().int().min(1).max(30).optional().describe("How many to list (default 10)"),
    }),
    async execute(rawInput, ctx) {
      const input = z.object({ includeDecided: z.boolean().optional(), limit: z.number().int().min(1).max(30).optional() }).parse(rawInput ?? {});
      const limit = input.limit ?? 10;
      const rows = await db
        .select({ id: approvals.id, summary: approvals.summary, status: approvals.status, createdAt: approvals.createdAt })
        .from(approvals)
        .where(
          input.includeDecided
            ? eq(approvals.agentId, ctx.actor.actorId)
            : and(eq(approvals.agentId, ctx.actor.actorId), eq(approvals.status, "pending")),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(limit);
      if (rows.length === 0) return { summary: input.includeDecided ? "(no approval requests)" : "(nothing waiting for approval)" };
      return {
        summary: rows
          .map((r) => `- [${r.status}] "${r.summary}" (id ${r.id}, filed ${r.createdAt.toISOString()})`)
          .join("\n"),
      };
    },
  };

  const listRoutines: AgentToolDef = {
    name: "list_my_routines",
    description:
      "List your scheduled routines (title, schedule, next run, on/off). Use when asked what's planned or scheduled.",
    inputSchema: z.object({}),
    async execute(_rawInput, ctx) {
      const projectId = ctx.actor.projectId;
      if (!projectId) return { summary: "No project context." };
      const rows = await db
        .select({ title: routines.title, schedule: routines.schedule, enabled: routines.enabled, nextRunAt: routines.nextRunAt, lastRunAt: routines.lastRunAt })
        .from(routines)
        .where(and(eq(routines.agentId, ctx.actor.actorId), eq(routines.projectId, projectId)))
        .orderBy(routines.createdAt);
      if (rows.length === 0) return { summary: "(no routines scheduled)" };
      return {
        summary: rows
          .map(
            (r) =>
              `- "${r.title}" — ${r.schedule}, ${r.enabled ? `next ${r.nextRunAt ? r.nextRunAt.toISOString() : "soon"}` : "OFF"}${
                r.lastRunAt ? `, last ran ${r.lastRunAt.toISOString()}` : ""
              }`,
          )
          .join("\n"),
      };
    },
  };

  return [listChats, listApprovals, listRoutines];
}
