import { asc, and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "../db/client.js";
import type { Database } from "../db/client.js";
import { agentMemory } from "../db/schema.js";
import type { OrgToolDef } from "./org-tools.js";

const rememberSchema = z.object({ note: z.string().min(1) });
const forgetSchema = z.object({ noteId: z.string().min(1) });

/**
 * Given to every agent, not just managers — this is what makes memory persist
 * across chats, projects, and meetings: agents write to it themselves, and it's
 * re-read into the system prompt on every turn (see agents/system-prompt.ts),
 * not tied to any one session's message history.
 */
export function createMemoryTools(db: Database): OrgToolDef[] {
  const remember: OrgToolDef = {
    name: "remember",
    description:
      "Save a note to your own persistent memory. It will show up in every future chat, project, and meeting you're part of, and the user can review (and delete) it too.",
    inputSchema: rememberSchema,
    async execute(rawInput, ctx) {
      const input = rememberSchema.parse(rawInput);
      await db.insert(agentMemory).values({ id: newId(), agentId: ctx.actor.actorId, note: input.note, createdAt: new Date() });
      return { summary: `Remembered: ${input.note}` };
    },
  };

  const listMemory: OrgToolDef = {
    name: "list_memory",
    description: "List everything currently in your persistent memory, with each note's id (needed for forget).",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const rows = await db
        .select()
        .from(agentMemory)
        .where(eq(agentMemory.agentId, ctx.actor.actorId))
        .orderBy(asc(agentMemory.createdAt));
      return { summary: rows.length > 0 ? rows.map((r) => `[${r.id}] ${r.note}`).join("\n") : "(your memory is empty)" };
    },
  };

  const forget: OrgToolDef = {
    name: "forget",
    description: "Remove a note from your persistent memory by id — use list_memory first to find it.",
    inputSchema: forgetSchema,
    async execute(rawInput, ctx) {
      const input = forgetSchema.parse(rawInput);
      await db.delete(agentMemory).where(and(eq(agentMemory.id, input.noteId), eq(agentMemory.agentId, ctx.actor.actorId)));
      return { summary: `Forgot note ${input.noteId}` };
    },
  };

  return [remember, listMemory, forget];
}
