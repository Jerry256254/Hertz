import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { newId } from "../db/client.js";
import type { Database } from "../db/client.js";
import { agents, employeeShellGrants, employeeShells, projectRoots } from "../db/schema.js";
import type { OrgToolDef } from "./org-tools.js";
import type { ShellManager } from "../shells/shell-manager.js";

const createShellSchema = z.object({ name: z.string().min(1) });
const runInShellSchema = z.object({ shellId: z.string().min(1), command: z.string().min(1) });
const shareShellSchema = z.object({ shellId: z.string().min(1), colleague: z.string().min(1) });

async function accessibleShells(db: Database, agentId: string) {
  const owned = await db.select().from(employeeShells).where(eq(employeeShells.ownerAgentId, agentId));
  const grantedRows = await db
    .select({ shell: employeeShells })
    .from(employeeShellGrants)
    .innerJoin(employeeShells, eq(employeeShellGrants.shellId, employeeShells.id))
    .where(eq(employeeShellGrants.agentId, agentId));
  const seen = new Set(owned.map((s) => s.id));
  const all = [...owned];
  for (const { shell } of grantedRows) {
    if (!seen.has(shell.id)) {
      all.push(shell);
      seen.add(shell.id);
    }
  }
  return all;
}

/**
 * A real, persistent Linux shell per employee (see shells/shell-manager.ts) —
 * distinct from the sandboxed, allowlisted shell_exec tool every agent already
 * has. Given to every agent, not just managers: each employee can open more
 * than one named shell and share access with a colleague, same as a human
 * team would share a terminal session.
 */
export function createShellTools(db: Database, shellManager: ShellManager): OrgToolDef[] {
  const createShell: OrgToolDef = {
    name: "create_shell",
    description: "Open a new named, persistent Linux shell for yourself — state (cwd, env vars, background jobs) survives between commands, unlike shell_exec.",
    inputSchema: createShellSchema,
    async execute(rawInput, ctx) {
      const input = createShellSchema.parse(rawInput);
      const id = newId();
      await db.insert(employeeShells).values({
        id,
        projectId: ctx.actor.projectId ?? "",
        ownerAgentId: ctx.actor.actorId,
        name: input.name,
        createdAt: new Date(),
      });
      return { summary: `Opened shell "${input.name}" [id: ${id}].` };
    },
  };

  const listMyShells: OrgToolDef = {
    name: "list_my_shells",
    description: "List every persistent shell you own or that's been shared with you, with its id and owner.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const shells = await accessibleShells(db, ctx.actor.actorId);
      if (shells.length === 0) return { summary: "(no shells yet — use create_shell)" };
      const ownerIds = [...new Set(shells.map((s) => s.ownerAgentId))];
      const ownerRows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ownerIds));
      const ownerName = new Map(ownerRows.map((o) => [o.id, o.name]));
      const lines = shells.map((s) => {
        const owner = s.ownerAgentId === ctx.actor.actorId ? "yours" : `shared by ${ownerName.get(s.ownerAgentId) ?? "?"}`;
        return `${s.name} [id: ${s.id}] — ${owner}`;
      });
      return { summary: lines.join("\n") };
    },
  };

  const runInShell: OrgToolDef = {
    name: "run_in_shell",
    description: "Run a command in one of your persistent shells (see list_my_shells for ids) and wait for it to finish. No allowlist here — this is a real shell, so be careful.",
    inputSchema: runInShellSchema,
    async execute(rawInput, ctx) {
      const input = runInShellSchema.parse(rawInput);
      const shells = await accessibleShells(db, ctx.actor.actorId);
      const shell = shells.find((s) => s.id === input.shellId);
      if (!shell) return { summary: `No accessible shell with id ${input.shellId}. Use list_my_shells first.`, isError: true };

      const rootRows = await db.select().from(projectRoots).where(eq(projectRoots.projectId, shell.projectId));
      const mainRoot = rootRows.find((r) => r.rootId === "main") ?? rootRows[0];
      if (!mainRoot) return { summary: "This shell's project has no root directory configured.", isError: true };

      const result = await shellManager.runCommand(shell.id, mainRoot.absolutePath, input.command, {
        actorId: ctx.actor.actorId,
        actorType: "agent",
        sessionId: ctx.actor.sessionId,
        projectId: shell.projectId,
        userId: ctx.actor.userId,
      });
      const status = result.timedOut ? " (timed out)" : ` (exit ${result.exitCode})`;
      return { summary: `${result.output}${status}`, isError: !result.timedOut && result.exitCode !== 0 };
    },
  };

  const shareShell: OrgToolDef = {
    name: "share_shell",
    description: "Give a colleague access to one of your persistent shells, by name (matched against the project team).",
    inputSchema: shareShellSchema,
    async execute(rawInput, ctx) {
      const input = shareShellSchema.parse(rawInput);
      const rows = await db.select().from(employeeShells).where(eq(employeeShells.id, input.shellId)).limit(1);
      const shell = rows[0];
      if (!shell || shell.ownerAgentId !== ctx.actor.actorId) {
        return { summary: `You don't own a shell with id ${input.shellId}.`, isError: true };
      }

      const teamRows = await db.select().from(agents).where(eq(agents.projectId, shell.projectId));
      const needle = input.colleague.toLowerCase();
      const candidates = teamRows.filter((a) => a.id !== ctx.actor.actorId && a.name.toLowerCase().includes(needle));
      if (candidates.length === 0) return { summary: `No teammate matching "${input.colleague}".`, isError: true };
      if (candidates.length > 1) {
        return { summary: `Multiple teammates match "${input.colleague}": ${candidates.map((c) => c.name).join(", ")}.`, isError: true };
      }

      const to = candidates[0]!;
      const existing = await db
        .select({ id: employeeShellGrants.id })
        .from(employeeShellGrants)
        .where(and(eq(employeeShellGrants.shellId, shell.id), eq(employeeShellGrants.agentId, to.id)))
        .limit(1);
      if (existing.length === 0) {
        await db.insert(employeeShellGrants).values({ id: newId(), shellId: shell.id, agentId: to.id, createdAt: new Date() });
      }
      return { summary: `Shared "${shell.name}" with ${to.name}.` };
    },
  };

  return [createShell, listMyShells, runInShell, shareShell];
}
