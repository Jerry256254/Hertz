import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import type { AgentToolDef } from "./tool-def.js";
import type { HertzPaths } from "../paths.js";
import { agentSkillsDir, assertInside } from "../paths.js";
import { resolveAgentProjectId } from "../memory/recall.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-_]{1,47}$/;

/** Defense in depth: strip any directory components, then the SLUG_RE check still applies. */
function safeSkillName(name: string): string {
  return path.basename(name);
}

const saveSchema = z.object({
  name: z
    .string()
    .regex(SLUG_RE, "Skill name: lowercase letters, digits, dashes (e.g. 'weekly-sales-report')")
    .describe("Short identifier for the skill"),
  description: z.string().min(1).max(200).describe("One line: when to use this skill — this is what future-you sees in the skill index"),
  instructions: z.string().min(1).describe("The full step-by-step procedure in markdown — concrete enough that following it reproduces the result exactly (tools to call, commands, templates, gotchas)"),
  script: z.string().optional().describe("Optional helper script content, saved as script.sh next to SKILL.md (chmod +x'd)"),
});

const readSchema = z.object({ name: z.string().min(1) });

async function safeRead(dir: string, file: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(dir, file), "utf8");
  } catch {
    return null;
  }
}

/**
 * Skills = the agent's self-written procedures (OpenClaw/Hermes-style). When an
 * agent solves something repeatable it saves the recipe; every later prompt
 * carries just the index (name + one-liner), and read_skill pulls the full
 * steps only when relevant. This is what turns a one-off chat into durable,
 * reusable automation.
 */
export function createSkillTools(db: Database, paths: HertzPaths): AgentToolDef[] {
  /** Skills live in the agent's home (his own project), following him across every chat. */
  async function skillsRoot(agentId: string): Promise<string | undefined> {
    const projectId = await resolveAgentProjectId(db, agentId).catch(() => undefined);
    if (!projectId) return undefined;
    const dir = agentSkillsDir(paths, projectId, agentId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  const saveSkill: AgentToolDef = {
    name: "save_skill",
    description:
      "Save a repeatable procedure you've figured out as a personal skill (survives across projects and chats; the user can see it). Use after completing anything you'd do again: a report someone liked, a deployment dance, a data-pull with quirks. Write instructions as if briefing a competent stranger — exact tool calls, commands, file paths, edge cases.",
    inputSchema: saveSchema,
    async execute(rawInput, ctx) {
      const input = saveSchema.parse(rawInput);
      const root = await skillsRoot(ctx.actor.actorId);
      if (!root) return { summary: "Skills are unavailable — the agent has no home project.", isError: true };
      const dir = assertInside(root, path.join(root, safeSkillName(input.name)), "skill");
      await fs.mkdir(dir, { recursive: true });

      const frontmatter = `---\nname: ${input.name}\ndescription: ${input.description}\nupdated: ${new Date().toISOString()}\n---\n\n`;
      await fs.writeFile(path.join(dir, "SKILL.md"), `${frontmatter}${input.instructions}\n`, "utf8");
      if (input.script) {
        const scriptPath = path.join(dir, "script.sh");
        await fs.writeFile(scriptPath, input.script, "utf8");
        await fs.chmod(scriptPath, 0o755);
      }

      await db.insert(auditLog).values({
        id: newId(),
        actorId: ctx.actor.actorId,
        actorType: "agent",
        sessionId: ctx.actor.sessionId ?? null,
        projectId: ctx.actor.projectId ?? null,
        action: "skill.save",
        target: input.name,
        targetType: "skill",
        result: "allowed",
        at: new Date(),
      });

      return {
        summary: `Skill "${input.name}" saved. It's in your index now — read_skill "${input.name}" whenever the situation matches: ${input.description}`,
      };
    },
  };

  const listSkills: AgentToolDef = {
    name: "list_skills",
    description: "List your saved skills (name + when-to-use). Consult this before reinventing a procedure — if a skill fits, read_skill and follow it.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const root = await skillsRoot(ctx.actor.actorId);
      if (!root) return { summary: "(skills unavailable)" };
      let entries: string[] = [];
      try {
        entries = await fs.readdir(root);
      } catch {
        return { summary: "(no skills saved yet)" };
      }
      const lines: string[] = [];
      for (const name of entries.sort()) {
        const raw = await safeRead(path.join(root, name), "SKILL.md");
        if (!raw) continue;
        const desc = raw.split("\n").find((l) => l.startsWith("description:"))?.slice("description:".length).trim() ?? "";
        lines.push(`- ${name} — ${desc}`);
      }
      return { summary: lines.length > 0 ? lines.join("\n") : "(no skills saved yet)" };
    },
  };

  const readSkill: AgentToolDef = {
    name: "read_skill",
    description: "Read the full step-by-step instructions of one of your saved skills. Use list_skills first if you're not sure of the name.",
    inputSchema: readSchema,
    async execute(rawInput, ctx) {
      const input = readSchema.parse(rawInput);
      const name = safeSkillName(input.name);
      if (!SLUG_RE.test(name)) return { summary: "Invalid skill name.", isError: true };
      const root = await skillsRoot(ctx.actor.actorId);
      if (!root) return { summary: "Skills are unavailable — the agent has no home project.", isError: true };
      const raw = await safeRead(assertInside(root, path.join(root, name), "skill"), "SKILL.md");
      if (!raw) return { summary: `No skill named "${input.name}" — check list_skills.`, isError: true };
      // Strip frontmatter; the body is what matters.
      const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
      return { summary: body || "(empty skill)" };
    },
  };

  const deleteSkill: AgentToolDef = {
    name: "delete_skill",
    description: "Delete one of your saved skills (it's outdated or wrong).",
    inputSchema: readSchema,
    async execute(rawInput, ctx) {
      const input = readSchema.parse(rawInput);
      const name = safeSkillName(input.name);
      if (!SLUG_RE.test(name)) return { summary: "Invalid skill name.", isError: true };
      const root = await skillsRoot(ctx.actor.actorId);
      if (!root) return { summary: "Skills are unavailable — the agent has no home project.", isError: true };
      await fs.rm(assertInside(root, path.join(root, name), "skill"), { recursive: true, force: true });
      return { summary: `Skill "${name}" deleted.` };
    },
  };

  return [saveSkill, listSkills, readSkill, deleteSkill];
}

/** Index injected into the system prompt: name + one-liner per skill (cheap), full text on demand via read_skill. */
export interface SkillIndexEntry {
  name: string;
  description: string;
}

export async function skillsIndexFor(paths: HertzPaths, projectId: string, agentId: string): Promise<SkillIndexEntry[]> {
  const root = agentSkillsDir(paths, projectId, agentId);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: Array<{ name: string; description: string }> = [];
  for (const name of entries.sort()) {
    const raw = await safeRead(path.join(root, name), "SKILL.md");
    if (!raw) continue;
    const desc = raw.split("\n").find((l) => l.startsWith("description:"))?.slice("description:".length).trim() ?? "";
    out.push({ name, description: desc });
  }
  return out;
}
