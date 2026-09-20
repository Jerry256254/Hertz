import fs from "node:fs/promises";
import path from "node:path";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "../db/client.js";
import type { Database } from "../db/client.js";
import { agentMemoryAtoms, agentMemoryScenarios } from "../db/schema.js";
import type { AgentToolDef } from "./tool-def.js";
import { assertInside, employeeDir, ensureEmployeeDirs, type HertzPaths } from "../paths.js";
import { keywordsFor } from "../memory/tokenize.js";
import { forgetById, loadPersona, resolveAgentProjectId, searchMemory } from "../memory/recall.js";
import { readRef } from "../memory/short-term.js";
import { removeAtomVector, syncAtomVectors } from "../memory/vector-store.js";

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
const recallSchema = z.object({
  query: z.string().min(1).describe("What to search your memory for — topics, names, past decisions, procedures"),
});
const readRefSchema = z.object({
  nodeId: z.string().min(1).describe("The ref id from an [Offloaded …] pointer or the session canvas, e.g. 'n3f9a2'"),
});

function safeNoteFilename(filename: string): string {
  const base = path.basename(filename).trim();
  return base.length > 0 ? base : "note.md";
}

/**
 * Given to every agent — this is what makes memory persist across chats,
 * projects and chats: the agent writes to it itself, and it's re-read
 * into the system prompt on every turn (see agents/system-prompt.ts).
 *
 * Layered model (L0 conversations in history → L1 atoms here → L2 scenarios →
 * L3 persona.md): remember() writes L1 atoms that the pipeline clusters and
 * distills; recall_memory drills down with full traceability; read_memory_ref
 * recovers offloaded tool output by node_id.
 */
export function createMemoryTools(db: Database, paths: HertzPaths): AgentToolDef[] {
  const remember: AgentToolDef = {
    name: "remember",
    description:
      "Save a note to your own persistent layered memory (L1 atom). Facts and preferences surface in future chats ranked by importance and relevance; the memory pipeline clusters them into scenarios and distills your persona automatically. The user can review (and delete) everything.",
    inputSchema: rememberSchema,
    async execute(rawInput, ctx) {
      const input = rememberSchema.parse(rawInput);
      await db.insert(agentMemoryAtoms).values({
        id: newId(),
        agentId: ctx.actor.actorId,
        text: input.note.slice(0, 500),
        importance: input.kind === "preference" && input.importance < 4 ? 4 : input.importance,
        keywords: keywordsFor(input.note),
        createdAt: new Date(),
      });
      // Embed the new atom for vector recall (fire-and-forget; the memory
      // pipeline re-syncs anything this misses).
      void syncAtomVectors(db, paths, ctx.actor.actorId).catch(() => {});
      return { summary: `Remembered (${input.kind}, importance ${input.importance}): ${input.note}` };
    },
  };

  const listMemory: AgentToolDef = {
    name: "list_memory",
    description: "List your persistent memory layer by layer (persona → scenarios → atoms), with each atom's id (needed for forget).",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const homeProjectId = await resolveAgentProjectId(db, ctx.actor.actorId).catch(() => undefined);
      const [persona, scenarios, atoms] = await Promise.all([
        homeProjectId ? loadPersona(paths, homeProjectId, ctx.actor.actorId).catch(() => "") : Promise.resolve(""),
        db.select().from(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, ctx.actor.actorId)).orderBy(desc(agentMemoryScenarios.updatedAt)).limit(20),
        db.select().from(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, ctx.actor.actorId)).orderBy(asc(agentMemoryAtoms.createdAt)).limit(200),
      ]);
      const parts: string[] = [];
      if (persona) parts.push(`## Persona (L3)\n${persona}`);
      if (scenarios.length > 0) {
        parts.push(`## Scenarios (L2)\n${scenarios.map((s) => `- ${s.slug}: ${s.title}`).join("\n")}`);
      }
      parts.push(atoms.length > 0 ? `## Atoms (L1)\n${atoms.map((r) => `[${r.id}] ${r.text}`).join("\n")}` : "## Atoms (L1)\n(your memory is empty)");
      return { summary: parts.join("\n\n") };
    },
  };

  const forget: AgentToolDef = {
    name: "forget",
    description: "Remove a note from your persistent memory by id — use list_memory first to find it.",
    inputSchema: forgetSchema,
    async execute(rawInput, ctx) {
      const input = forgetSchema.parse(rawInput);
      const deleted = await forgetById(db, ctx.actor.actorId, input.noteId);
      if (deleted) removeAtomVector(paths, input.noteId);
      return deleted ? { summary: `Forgot note ${input.noteId}` } : { summary: `No memory entry ${input.noteId} — check list_memory.`, isError: true };
    },
  };

  const recallMemory: AgentToolDef = {
    name: "recall_memory",
    description:
      "Search your own layered long-term memory (scenarios + atoms) for anything the current prompt doesn't show — past decisions, procedures, names, project details. Returns matches with drill-down traces (persona › scenario › atom › source conversation). Use before asking the user something you might already know.",
    inputSchema: recallSchema,
    async execute(rawInput, ctx) {
      const input = recallSchema.parse(rawInput);
      const hits = await searchMemory(db, ctx.actor.actorId, input.query, paths);
      if (hits.length === 0) return { summary: `(no memory matches for "${input.query}")` };
      return {
        summary: hits.map((h) => `- [${h.layer}] ${h.text}\n  trace: ${h.trace}`).join("\n"),
      };
    },
  };

  const readMemoryRef: AgentToolDef = {
    name: "read_memory_ref",
    description:
      "Retrieve the FULL text of an offloaded tool result by its node_id (from an [Offloaded …] pointer or the session canvas). The history only keeps an excerpt — this recovers every byte.",
    inputSchema: readRefSchema,
    async execute(rawInput, ctx) {
      const input = readRefSchema.parse(rawInput);
      const homeProjectId = await resolveAgentProjectId(db, ctx.actor.actorId).catch(() => undefined);
      if (!homeProjectId) return { summary: "Memory refs are unavailable — the agent has no home project.", isError: true };
      const full = await readRef(paths, homeProjectId, ctx.actor.actorId, input.nodeId, ctx.actor.sessionId ?? undefined);
      if (!full) return { summary: `No offloaded ref "${input.nodeId}" — it may belong to another agent or was never offloaded.`, isError: true };
      return { summary: full.slice(0, 12000) };
    },
  };

  const saveNote: AgentToolDef = {
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
      const target = assertInside(dir, path.join(dir, filename), "note");
      await fs.writeFile(target, input.content, "utf8");
      return { summary: `Saved notes/${filename} (${Buffer.byteLength(input.content, "utf8")} bytes)` };
    },
  };

  return [remember, listMemory, forget, recallMemory, readMemoryRef, saveNote];
}
