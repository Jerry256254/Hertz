import fs from "node:fs/promises";
import path from "node:path";
import { asc, and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "../db/client.js";
import type { Database } from "../db/client.js";
import { agentMemory } from "../db/schema.js";
import type { OrgToolDef } from "./org-tools.js";
import { employeeDir, ensureEmployeeDirs, type HertzPaths } from "../paths.js";

const rememberSchema = z.object({
  note: z.string().min(1),
  kind: z
    .enum(["fact", "preference"])
    .optional()
    .default("fact")
    .describe("'fact' = durable knowledge about the project/world; 'preference' = how the user wants you to behave (always honored)"),
  importance: z.number().int().min(1).max(5).optional().default(3).describe("1 = minor detail, 3 = useful, 5 = critical, always-relevant"),
});
const forgetSchema = z.object({ noteId: z.string().min(1) });
const saveNoteSchema = z.object({
  filename: z.string().min(1).describe("e.g. 'meeting-summary.md' — saved under your notes/ folder"),
  content: z.string().min(1),
});

function safeNoteFilename(filename: string): string {
  const base = path.basename(filename).trim();
  return base.length > 0 ? base : "note.md";
}

/**
 * Given to every agent, not just managers — this is what makes memory persist
 * across chats, projects, and meetings: agents write to it themselves, and it's
 * re-read into the system prompt on every turn (see agents/system-prompt.ts),
 * not tied to any one session's message history.
 */
export function createMemoryTools(db: Database, paths: HertzPaths): OrgToolDef[] {
  const remember: OrgToolDef = {
    name: "remember",
    description:
      "Save a note to your own persistent memory. Facts and preferences surface in future chats ranked by importance and relevance; episodes of what you did are auto-captured too. The user can review (and delete) everything.",
    inputSchema: rememberSchema,
    async execute(rawInput, ctx) {
      const input = rememberSchema.parse(rawInput);
      const keywords = input.note
        .toLowerCase()
        .split(/[^a-z0-9ěščřžýáíéúů]+/)
        .filter((w) => w.length >= 3)
        .slice(0, 12)
        .join(",");
      await db.insert(agentMemory).values({
        id: newId(),
        agentId: ctx.actor.actorId,
        note: input.note,
        kind: input.kind,
        importance: input.importance,
        keywords,
        createdAt: new Date(),
      });
      return { summary: `Remembered (${input.kind}, importance ${input.importance}): ${input.note}` };
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

  const saveNote: OrgToolDef = {
    name: "save_note",
    description:
      "Save a longer piece of material (a draft, a summary, research notes) as a file in your own notes/ folder — unlike remember, this doesn't get injected into your prompt every turn, so it's for things you'll deliberately read back later, not short facts.",
    inputSchema: saveNoteSchema,
    async execute(rawInput, ctx) {
      const input = saveNoteSchema.parse(rawInput);
      if (!ctx.actor.projectId) return { summary: "No project context to save a note in.", isError: true };
      await ensureEmployeeDirs(paths, ctx.actor.projectId, ctx.actor.actorId);
      const dir = path.join(employeeDir(paths, ctx.actor.projectId, ctx.actor.actorId), "notes");
      const filename = safeNoteFilename(input.filename);
      await fs.writeFile(path.join(dir, filename), input.content, "utf8");
      return { summary: `Saved notes/${filename} (${Buffer.byteLength(input.content, "utf8")} bytes)` };
    },
  };

  return [remember, listMemory, forget, saveNote];
}
