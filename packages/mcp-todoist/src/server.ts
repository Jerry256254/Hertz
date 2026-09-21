#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const token = process.env.TODOIST_TOKEN;
/** Overridable for tests/QA — production default is the Todoist API. */
const apiBase = (process.env.TODOIST_API_ROOT ?? "https://api.todoist.com/api/v1").replace(/\/$/, "");

if (!token) {
  console.error("mcp-todoist: missing TODOIST_TOKEN");
  process.exit(1);
}

/**
 * Every request goes through here so auth headers are set in exactly one
 * place — and so a failed call can never leak the token into the error text
 * (only status + Todoist's message are surfaced).
 */
async function todoistFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "kuclab-hertz-mcp-todoist",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 500);
    try {
      detail = (JSON.parse(body) as { error?: string }).error ?? detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`Todoist API error ${res.status}: ${detail}`);
  }
  return body ? JSON.parse(body) : {};
}

const server = new McpServer({ name: "kuclab-hertz-todoist", version: "0.1.0" });

function formatTask(t: any): string {
  const due = t.due ? ` (termín: ${t.due.date}${t.due.datetime ? ` ${t.due.datetime}` : ""})` : "";
  const prio = t.priority > 1 ? ` [P${t.priority}]` : "";
  return `- ${t.content}${prio}${due} — id ${t.id}`;
}

server.registerTool(
  "todoist_list_tasks",
  {
    description: "List Todoist tasks, optionally filtered by project or Todoist filter query.",
    inputSchema: {
      projectId: z.string().optional().describe("Limit to a project id (see todoist_list_projects)"),
      filter: z.string().optional().describe("Todoist filter query, e.g. 'today' or 'priority 4'"),
      limit: z.number().int().positive().max(200).optional().default(50),
    },
  },
  async ({ projectId, filter, limit }) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (projectId) q.set("project_id", projectId);
    if (filter) q.set("filter", filter);
    const res: any = await todoistFetch(`/tasks?${q}`);
    const tasks: any[] = res.results ?? [];
    if (tasks.length === 0) return { content: [{ type: "text", text: "No tasks found." }] };
    return { content: [{ type: "text", text: tasks.map(formatTask).join("\n") }] };
  },
);

server.registerTool(
  "todoist_create_task",
  {
    description: "Create a new task in Todoist (inbox unless a project is given).",
    inputSchema: {
      content: z.string().max(1000).describe("Task title"),
      description: z.string().max(10_000).optional(),
      projectId: z.string().optional(),
      dueString: z.string().optional().describe("Natural-language due date, e.g. 'tomorrow at 9am' or 'next Monday'"),
      priority: z.number().int().min(1).max(4).optional().describe("1 (normal) to 4 (urgent)"),
    },
  },
  async ({ content, description, projectId, dueString, priority }) => {
    const t: any = await todoistFetch("/tasks", {
      method: "POST",
      body: JSON.stringify({
        content,
        ...(description ? { description } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        ...(dueString ? { due_string: dueString } : {}),
        ...(priority ? { priority } : {}),
      }),
    });
    return { content: [{ type: "text", text: `Created task: ${formatTask(t)}` }] };
  },
);

server.registerTool(
  "todoist_complete_task",
  {
    description: "Mark a Todoist task as done.",
    inputSchema: { taskId: z.string().describe("Task id (see todoist_list_tasks)") },
  },
  async ({ taskId }) => {
    await todoistFetch(`/tasks/${encodeURIComponent(taskId)}/close`, { method: "POST" });
    return { content: [{ type: "text", text: `Task ${taskId} marked as done.` }] };
  },
);

server.registerTool(
  "todoist_list_projects",
  {
    description: "List Todoist projects.",
    inputSchema: {},
  },
  async () => {
    const res: any = await todoistFetch("/projects");
    const projects: any[] = res.results ?? [];
    if (projects.length === 0) return { content: [{ type: "text", text: "No projects found." }] };
    const text = projects.map((p) => `- ${p.name} — id ${p.id}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
