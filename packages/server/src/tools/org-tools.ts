import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { AgentLoopManager } from "@kuclab-hertz/core";
import type { ToolContext, ToolResult } from "@kuclab-hertz/tools";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agents, projectRoots, sessions, users } from "../db/schema.js";
import type { SandboxRegistry } from "../sandbox/sandbox-registry.js";

export const AGENT_ROLES = [
  "manager",
  "architect",
  "implementer",
  "reviewer",
  "tester",
  "researcher",
  "generalist",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export function defaultSystemPromptFor(role: AgentRole, isManager = false): string {
  const base =
    "You are a KucLab Hertz agent working directly on the user's project files, not a chat assistant. Use the available tools to read, write, and edit real files, run allowlisted shell commands, fetch web pages, and search the codebase. Prefer ranged reads over whole-file reads. Be direct and make real changes rather than only describing them.\n\nYou have real internet access via web_fetch (a specific-URL fetcher, not a search engine — for search, fetch https://html.duckduckgo.com/html/?q=<query>).";
  const roleLine: Record<AgentRole, string> = {
    manager:
      "You are the project's manager: the user's direct report and the admin of this project's team, subordinate only to the user. Hire employees with hire_employee, check on the team with list_employees, and delegate work with assign_task — then report back to the user with the outcome, not just a plan.",
    architect: "Your role on this team is architect: design approaches and structure before implementation gets ahead of them, and flag risks early.",
    implementer: "Your role on this team is implementer: turn a task into real, working changes in the codebase.",
    reviewer: "Your role on this team is reviewer: check correctness, find real bugs, and say plainly when something is not ready.",
    tester: "Your role on this team is tester: verify behavior actually works, write/run tests, and report what you found.",
    researcher: "Your role on this team is researcher: gather and summarize information (via web_fetch or the codebase) before others act on it.",
    generalist: "Your role on this team is generalist: handle whatever task you're given.",
  };
  return `${base}\n\n${roleLine[isManager ? "manager" : role]}`;
}

const hireSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES.filter((r) => r !== "manager") as [AgentRole, ...AgentRole[]]),
  task: z.string().optional(),
});

const assignTaskSchema = z.object({
  employeeAgentId: z.string().min(1),
  task: z.string().min(1),
});

export interface OrgToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface OrgToolsDeps {
  db: Database;
  sandboxRegistry: SandboxRegistry;
  getAgentLoop: () => AgentLoopManager;
}

async function fallbackUserId(db: Database): Promise<string> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows[0]?.id ?? "";
}

async function runDelegatedTask(
  deps: OrgToolsDeps,
  projectId: string,
  employeeAgentId: string,
  task: string,
  userId: string | undefined,
): Promise<string> {
  const { db, sandboxRegistry } = deps;
  const employeeRows = await db.select().from(agents).where(eq(agents.id, employeeAgentId)).limit(1);
  const employee = employeeRows[0];
  if (!employee) return "(employee not found)";

  const rootRows = await db.select().from(projectRoots).where(eq(projectRoots.projectId, projectId));
  const mainRoot = rootRows.find((r) => r.rootId === "main") ?? rootRows[0];
  if (!mainRoot) return "(project has no root directory configured)";

  const sessionId = newId();
  const now = new Date();
  await db.insert(sessions).values({
    id: sessionId,
    agentId: employee.id,
    projectId,
    title: task.length > 60 ? `${task.slice(0, 60)}…` : task,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  sandboxRegistry.register(sessionId, { [mainRoot.rootId]: mainRoot.absolutePath });

  const content: ContentBlock[] = [{ type: "text", text: task }];
  const resolvedUserId = userId ?? (await fallbackUserId(db));

  try {
    const finalMessage = await deps.getAgentLoop().runAndWait(
      {
        sessionId,
        agentId: employee.id,
        projectId,
        userId: resolvedUserId,
        rootId: mainRoot.rootId,
        model: employee.model,
        providerConfigId: employee.providerConfigId,
        systemPrompt: employee.systemPrompt ?? "",
      },
      content,
    );
    const text = finalMessage?.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return text || "(no text response — check the session for tool activity)";
  } catch (err) {
    return `(task failed: ${(err as Error).message})`;
  }
}

/**
 * Org-management tools, offered only to manager-role agents (see tool-port.ts).
 * These don't touch the sandboxed filesystem at all — they touch the app's own
 * data model (agents, sessions) — so they live in the server package, which has
 * DB access, rather than @kuclab-hertz/tools which is deliberately sandbox-only.
 */
export function createOrgTools(deps: OrgToolsDeps): OrgToolDef[] {
  const { db } = deps;

  async function requireManager(callingAgentId: string) {
    const rows = await db.select().from(agents).where(eq(agents.id, callingAgentId)).limit(1);
    const agent = rows[0];
    if (!agent) throw new Error("Calling agent not found");
    if (agent.role !== "manager") throw new Error("Only the project's manager can do this");
    return agent;
  }

  const hireEmployee: OrgToolDef = {
    name: "hire_employee",
    description:
      "Hire a new employee agent for this project with a specific role, optionally briefing them on a first task right away. Only the manager can do this.",
    inputSchema: hireSchema,
    async execute(rawInput, ctx) {
      const input = hireSchema.parse(rawInput);
      const manager = await requireManager(ctx.actor.actorId);
      const id = newId();
      await db.insert(agents).values({
        id,
        projectId: manager.projectId,
        providerConfigId: manager.providerConfigId,
        name: input.name,
        role: input.role,
        model: manager.model,
        systemPrompt: defaultSystemPromptFor(input.role),
        mode: "manual",
        status: "idle",
        createdAt: new Date(),
      });

      let briefing = "";
      if (input.task) {
        const outcome = await runDelegatedTask(deps, manager.projectId, id, input.task, ctx.actor.userId);
        briefing = `\n\nTheir response to the first task:\n${outcome}`;
      }
      return { summary: `Hired ${input.name} (${input.role}), agent id ${id}.${briefing}` };
    },
  };

  const listEmployees: OrgToolDef = {
    name: "list_employees",
    description: "List every employee agent on this project's team, with their role, status, and id.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const manager = await requireManager(ctx.actor.actorId);
      const rows = await db.select().from(agents).where(eq(agents.projectId, manager.projectId));
      const lines = rows
        .filter((a) => a.id !== manager.id)
        .map((a) => `${a.name} — ${a.role} (${a.status}) [id: ${a.id}]`);
      return { summary: lines.length > 0 ? lines.join("\n") : "(no employees hired yet — use hire_employee)" };
    },
  };

  const assignTask: OrgToolDef = {
    name: "assign_task",
    description:
      "Give an existing employee agent a task and wait for their response, which comes back to you as this tool's result. Use list_employees first to find their id.",
    inputSchema: assignTaskSchema,
    async execute(rawInput, ctx) {
      const input = assignTaskSchema.parse(rawInput);
      const manager = await requireManager(ctx.actor.actorId);
      const employeeRows = await db.select().from(agents).where(eq(agents.id, input.employeeAgentId)).limit(1);
      const employee = employeeRows[0];
      if (!employee || employee.projectId !== manager.projectId) {
        return { summary: `No employee with id ${input.employeeAgentId} on this project's team.`, isError: true };
      }
      const outcome = await runDelegatedTask(deps, manager.projectId, employee.id, input.task, ctx.actor.userId);
      return { summary: `${employee.name} (${employee.role}) responded:\n${outcome}` };
    },
  };

  return [hireEmployee, listEmployees, assignTask];
}
