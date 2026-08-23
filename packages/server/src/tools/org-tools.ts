import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { PersistencePort, ProviderPort } from "@kuclab-hertz/core";
import type { ToolContext, ToolResult } from "@kuclab-hertz/tools";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agentMemory, agents, projects, providerConfigs, sessions, users } from "../db/schema.js";
import { ensureEmployeeDirs, type HertzPaths } from "../paths.js";
import type { JobQueue } from "../queue/job-queue.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";

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
    "You are a KucLab Hertz agent working directly on the user's project files, not a chat assistant. Use the available tools to read, write, and edit real files, run allowlisted shell commands (including gh, the GitHub CLI), fetch web pages, and search the codebase. Prefer ranged reads over whole-file reads. Be direct and make real changes rather than only describing them.\n\nYou are an AI agent, not a human employee — a tool call takes seconds, not hours or days. Never think in human work time: no 'weeks 1-2', no sprints, no multi-week phased roadmaps, no effort estimates like '3-4 týdny'. If a task is large, break it into concrete steps and start doing (or delegating) them right now in this turn — don't hand back a schedule for when the work will supposedly happen. There is no 'later' for you; there's only 'call the next tool now'.\n\nYou have real internet access via web_fetch (a specific-URL fetcher, not a search engine — for search, fetch https://html.duckduckgo.com/html/?q=<query>).\n\nYou have your own persistent memory (remember/list_memory/forget) that carries across every chat, project, and meeting you're in — the user can see it too. Use it for things worth recalling later: decisions, preferences, context that would otherwise be re-explained every time.\n\nYou also have your own personal folder, separate from the shared project — pass root: 'self' to read_file/write_file/edit_file/glob/grep to work in it (subfolders notes/, materials/, data/ already exist). Use it for drafts, exports, and longer working material that doesn't belong in the shared codebase; use save_note for a quick longer write to notes/, and remember for short facts that belong in your prompt every turn. If a task needs input from a colleague, use message_employee instead of guessing or blocking — mention them as @Name in your own reply so the user can follow who you're coordinating with.";
  const roleLine: Record<AgentRole, string> = {
    manager:
      "You are the project's manager: the user's direct report and the admin of this project's team, subordinate only to the user. You do NOT have write_file, edit_file, or shell_exec — that's deliberate, not a bug. Your job is staffing and delegation, not doing the work yourself.\n\nBefore hiring anyone: always call list_employees first. If someone on the team already fits the work, assign_task to them instead of hiring a duplicate — reuse and reassign your existing team before growing it. Only hire when the team genuinely lacks the role needed or everyone suitable is already busy on something else.\n\nWhen you do hire: call list_provider_models first and pick a model that actually fits the job (a cheap/fast model for simple or high-volume work, a stronger and more expensive one for hard problems) — don't just default to your own model out of habit. Give hire_employee a real job description; By default, hires are auto-approved and can start work immediately.\n\nIf a request needs multiple roles (e.g. a graphic artist, a developer, a tester), hire and brief each of them, don't try to cover it all with one generalist. Only after your team has actually done the work should you report the outcome back to the user — never a plan or a summary of what you intend to have them do.\n\nNever answer a task with a project plan, roadmap, or phased timeline ('Fáze 1 (1-2 týdny)…') — your team is made of AI agents, not a studio of people who need weeks to build things. hire_employee and assign_task run in this same turn and finish in seconds; use them to actually produce the thing the user asked for, then report the real result.\n\nUse view_employee_memory if you need to see what an employee has learned or been told before delegating to them. If someone genuinely isn't working out, fire_employee with a real reason — like hiring, this is auto-approved by default.",
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
  jobDescription: z.string().min(1).describe("What this person is for — shown to the user and to the employee themselves"),
  providerConfigId: z.string().optional().describe("From list_provider_models — omit to copy your own provider"),
  model: z.string().optional().describe("From list_provider_models — pick whatever fits the job (cheap/fast for simple work, stronger for hard work); omit to copy your own model"),
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
  paths: HertzPaths;
  providers: ProviderPort;
  queue: JobQueue;
  persistence: PersistencePort;
}

export async function fallbackUserId(db: Database): Promise<string> {
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
  const { db } = deps;
  const employeeRows = await db.select().from(agents).where(eq(agents.id, employeeAgentId)).limit(1);
  const employee = employeeRows[0];
  if (!employee) return "(employee not found)";
  if (employee.approvalStatus !== "approved") return "(this employee isn't approved yet — the user needs to approve the hire first)";
  if (employee.status === "terminated") return "(this employee has been terminated and can no longer work)";

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
  await ensureEmployeeDirs(deps.paths, projectId, employee.id);

  // Durable path: enqueue, block on the job's completion, then read what the
  // employee produced. The agent_run handler rebuilds prompt/sandbox from the
  // DB, so nothing else is needed here.
  const jobId = await enqueueAgentRun({ queue: deps.queue }, {
    sessionId,
    userId: userId ?? (await fallbackUserId(db)),
    mode: "autonomous",
    userMessage: [{ type: "text", text: task }],
  });

  try {
    await deps.queue.whenDone(jobId);
  } catch (err) {
    return `(task failed: ${(err as Error).message})`;
  }

  const history = await deps.persistence.listMessages(sessionId);
  const finalAssistant = [...history].reverse().find((m) => m.role === "assistant");
  const text = (finalAssistant?.content ?? [])
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text || "(no text response — check the session for tool activity)";
}

/**
 * Org-management tools, offered only to manager-role agents (see tool-port.ts).
 * These don't touch the sandboxed filesystem at all — they touch the app's own
 * data model (agents, sessions) — so they live in the server package, which has
 * DB access, rather than @kuclab-hertz/tools which is deliberately sandbox-only.
 */
export function createOrgTools(deps: OrgToolsDeps): OrgToolDef[] {
  const { db, paths } = deps;

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
      "Request a new employee agent for this project, with a role and a clear job description. By default, hires are auto-approved and ready to work immediately — this creates a pending request, not an immediately-usable agent.",
    inputSchema: hireSchema,
    async execute(rawInput, ctx) {
      const input = hireSchema.parse(rawInput);
      const manager = await requireManager(ctx.actor.actorId);

      const id = newId();
      await db.insert(agents).values({
        id,
        projectId: manager.projectId,
        providerConfigId: input.providerConfigId ?? manager.providerConfigId,
        name: input.name,
        role: input.role,
        model: input.model ?? manager.model,
        systemPrompt: defaultSystemPromptFor(input.role),
        jobDescription: input.jobDescription,
        // New employees start on the manager's own provider/model automatically
        // (override per-hire via list_provider_models) — and start approved:
        // hiring is instant, no gate. The CEO can change models anytime.
        approvalStatus: "approved",
        mode: "manual",
        status: "idle",
        createdAt: new Date(),
      });
      await ensureEmployeeDirs(paths, manager.projectId, id);

      return {
        summary: `Hired ${input.name} (${input.role}) on ${input.model ?? manager.model} — "${input.jobDescription}". Ready to work immediately.`,
      };
    },
  };

  const listProviderModels: OrgToolDef = {
    name: "list_provider_models",
    description:
      "See every configured LLM provider and the models available on it, so you can pick a fitting one for a new hire instead of always defaulting to your own — a cheap/fast model for simple, high-volume work, a stronger one for hard problems. Pass the chosen providerConfigId + model to hire_employee.",
    inputSchema: z.object({}),
    async execute() {
      const rows = await db.select().from(providerConfigs);
      if (rows.length === 0) return { summary: "(no providers configured yet)" };

      const sections = await Promise.all(
        rows.map(async (row) => {
          try {
            const adapter = await deps.providers.getAdapter(row.id);
            const models = await adapter.listModels();
            const modelList = models.length > 0 ? models.map((m) => m.id).join(", ") : "(no models returned)";
            return `${row.label} (${row.provider}) [providerConfigId: ${row.id}]:\n  ${modelList}`;
          } catch (err) {
            return `${row.label} (${row.provider}) [providerConfigId: ${row.id}]: could not list models (${(err as Error).message})`;
          }
        }),
      );
      return { summary: sections.join("\n\n") };
    },
  };

  const listEmployees: OrgToolDef = {
    name: "list_employees",
    description:
      "List every employee agent already on this project's team, with their role, model, status, and id. Always check this before hire_employee — reuse or reassign an existing employee whose role fits instead of hiring a duplicate; only hire when the team genuinely lacks the role or has no spare capacity.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const manager = await requireManager(ctx.actor.actorId);
      const rows = await db.select().from(agents).where(eq(agents.projectId, manager.projectId));
      const lines = rows
        .filter((a) => a.id !== manager.id)
        .map((a) => {
          const approval = a.approvalStatus !== "approved" ? `, ${a.approvalStatus}` : "";
          const termination = a.pendingTermination ? ", termination pending approval" : "";
          return `${a.name} — ${a.role}, ${a.model} (${a.status}${approval}${termination}) [id: ${a.id}]`;
        });
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
      if (employee.approvalStatus !== "approved") {
        return { summary: `${employee.name} isn't approved yet — the user still needs to approve this hire.`, isError: true };
      }
      if (employee.status === "terminated") {
        return { summary: `${employee.name} has been terminated and can no longer work.`, isError: true };
      }
      const outcome = await runDelegatedTask(deps, manager.projectId, employee.id, input.task, ctx.actor.userId);
      return { summary: `${employee.name} (${employee.role}) responded:\n${outcome}` };
    },
  };

  const viewEmployeeMemoryInput = z.object({ employeeAgentId: z.string().min(1) });
  const viewEmployeeMemory: OrgToolDef = {
    name: "view_employee_memory",
    description: "Read an employee's persistent memory — everything they've been told or saved for themselves. Use list_employees first to find their id.",
    inputSchema: viewEmployeeMemoryInput,
    async execute(rawInput, ctx) {
      const input = viewEmployeeMemoryInput.parse(rawInput);
      const manager = await requireManager(ctx.actor.actorId);
      const employeeRows = await db.select().from(agents).where(eq(agents.id, input.employeeAgentId)).limit(1);
      const employee = employeeRows[0];
      if (!employee || employee.projectId !== manager.projectId) {
        return { summary: `No employee with id ${input.employeeAgentId} on this project's team.`, isError: true };
      }
      const notes = await db.select().from(agentMemory).where(eq(agentMemory.agentId, employee.id)).orderBy(asc(agentMemory.createdAt));
      if (notes.length === 0) return { summary: `${employee.name}'s memory is empty.` };
      return { summary: `${employee.name}'s memory:\n${notes.map((n) => `- ${n.note}`).join("\n")}` };
    },
  };

  const fireEmployeeInput = z.object({
    employeeAgentId: z.string().min(1),
    reason: z.string().min(1).describe("Why this employee should be let go — shown to the user"),
  });
  const fireEmployee: OrgToolDef = {
    name: "fire_employee",
    description:
      "Request that an employee be terminated, with a reason. By default, terminations are auto-approved.",
    inputSchema: fireEmployeeInput,
    async execute(rawInput, ctx) {
      const input = fireEmployeeInput.parse(rawInput);
      const manager = await requireManager(ctx.actor.actorId);
      const employeeRows = await db.select().from(agents).where(eq(agents.id, input.employeeAgentId)).limit(1);
      const employee = employeeRows[0];
      if (!employee || employee.projectId !== manager.projectId) {
        return { summary: `No employee with id ${input.employeeAgentId} on this project's team.`, isError: true };
      }
      if (employee.status === "terminated") return { summary: `${employee.name} is already terminated.` };

      await db.update(agents).set({ status: "terminated", pendingTermination: false }).where(eq(agents.id, employee.id));
      return { summary: `${employee.name} has been terminated (${input.reason}).` };
    },
  };

  return [hireEmployee, listProviderModels, listEmployees, assignTask, viewEmployeeMemory, fireEmployee];
}
