import { eq } from "drizzle-orm";
import z from "zod";
import type { AgentLoopManager } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { agents, agentProjects } from "../db/schema.js";
import type { OrgToolDef } from "./org-tools.js";
import {
  deliverConversationMessage,
  ensureConversationSession,
  startConversationReplyRun,
  type ConversationDeps,
} from "../conversations.js";
import type { JobQueue } from "../queue/job-queue.js";

const messageSchema = z.object({
  colleague: z
    .string()
    .min(1)
    .describe("Name (or part of it) of the teammate to message — matched against everyone on this project's team"),
  message: z.string().min(1),
});

/**
 * Given to every agent, not just managers — this is what makes employee-to-
 * employee coordination real instead of always routing through the manager.
 * Every message lands in the pair's direct conversation (a real thread with its
 * own context window the user can open like any chat) and the recipient replies
 * automatically when idle, or answers mid-run without stopping their current
 * work. Always visible to the user for oversight, same principle as meetings:
 * nothing agent-to-agent happens off the record.
 */
export function createMessagingTools(deps: {
  db: Database;
  /** Lazy — AgentLoopManager doesn't exist yet when the tool port is constructed. */
  getAgentLoop: () => AgentLoopManager;
  queue: JobQueue;
}): OrgToolDef[] {
  const loopDeps = (): ConversationDeps => ({
    db: deps.db,
    agentLoop: deps.getAgentLoop(),
    queue: deps.queue,
  });

  const messageEmployee: OrgToolDef = {
    name: "message_employee",
    description:
      "Send a message to a colleague on this project's team — it lands in your direct chat with them (both the recipient and the user can see it), and they'll answer even while they're mid-work. Use this instead of guessing when you need input from someone else, or to loop them in on something relevant (mention them as @Name in your own reply so the user can follow along).",
    inputSchema: messageSchema,
    async execute(rawInput, ctx) {
      const input = messageSchema.parse(rawInput);
      const projectId = ctx.actor.projectId;
      if (!projectId) return { summary: "No project context to message a colleague in.", isError: true };

      const homeRows = await loopDeps().db.select().from(agents).where(eq(agents.projectId, projectId));
      const attachedRows = await loopDeps().db
        .select({ agent: agents })
        .from(agentProjects)
        .innerJoin(agents, eq(agentProjects.agentId, agents.id))
        .where(eq(agentProjects.projectId, projectId));

      const seen = new Set(homeRows.map((a) => a.id));
      const team = [...homeRows];
      for (const { agent } of attachedRows) {
        if (!seen.has(agent.id)) {
          team.push(agent);
          seen.add(agent.id);
        }
      }

      const needle = input.colleague.toLowerCase();
      const candidates = team.filter((a) => a.id !== ctx.actor.actorId && a.name.toLowerCase().includes(needle));
      if (candidates.length === 0) {
        return { summary: `No teammate matching "${input.colleague}" found on this project.`, isError: true };
      }
      if (candidates.length > 1) {
        return {
          summary: `Multiple teammates match "${input.colleague}": ${candidates.map((c) => c.name).join(", ")} — be more specific.`,
          isError: true,
        };
      }

      const to = candidates[0]!;
      const from = await loopDeps().db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, ctx.actor.actorId))
        .limit(1);

      const conversation = await ensureConversationSession(loopDeps(), {
        projectId,
        senderId: ctx.actor.actorId,
        recipientId: to.id,
        senderName: from[0]?.name ?? "A colleague",
        recipientName: to.name,
      });

      await deliverConversationMessage(loopDeps(), {
        sessionId: conversation.id,
        senderAgentId: ctx.actor.actorId,
        text: input.message,
      });

      void startConversationReplyRun(loopDeps(), {
        sessionId: conversation.id,
        actorAgentId: to.id,
        projectId,
        userId: ctx.actor.userId,
        incomingText: input.message,
      });

      return { summary: `Sent to ${to.name}: "${input.message}"` };
    },
  };

  return [messageEmployee];
}
