import { eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "../db/client.js";
import type { Database } from "../db/client.js";
import { agentProjects, agents, employeeMessages } from "../db/schema.js";
import type { OrgToolDef } from "./org-tools.js";

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
 * Messages are async (the recipient sees it whenever they next run, not
 * mid-turn) and always visible to the user for oversight, same principle as
 * meetings: nothing agent-to-agent happens off the record.
 */
export function createMessagingTools(db: Database): OrgToolDef[] {
  const messageEmployee: OrgToolDef = {
    name: "message_employee",
    description:
      "Send an async message to a colleague on this project's team — they'll see it next time they run, and the user can see it too. Use this instead of guessing when you need input from someone else, or to loop them in on something relevant (mention them as @Name in your own reply so the user can follow along).",
    inputSchema: messageSchema,
    async execute(rawInput, ctx) {
      const input = messageSchema.parse(rawInput);
      const projectId = ctx.actor.projectId;
      if (!projectId) return { summary: "No project context to message a colleague in.", isError: true };

      const homeRows = await db.select().from(agents).where(eq(agents.projectId, projectId));
      const attachedRows = await db
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
      await db.insert(employeeMessages).values({
        id: newId(),
        projectId,
        fromAgentId: ctx.actor.actorId,
        toAgentId: to.id,
        body: input.message,
        createdAt: new Date(),
      });
      return { summary: `Sent to ${to.name}: "${input.message}"` };
    },
  };

  return [messageEmployee];
}
