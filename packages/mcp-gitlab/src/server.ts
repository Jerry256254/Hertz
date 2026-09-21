#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const token = process.env.GITLAB_TOKEN;
/** Overridable for tests/QA — production default is gitlab.com. */
const apiBase = (process.env.GITLAB_API_ROOT ?? "https://gitlab.com/api/v4").replace(/\/$/, "");

if (!token) {
  console.error("mcp-gitlab: missing GITLAB_TOKEN");
  process.exit(1);
}

/**
 * Every request goes through here so auth headers are set in exactly one
 * place — and so a failed call can never leak the token into the error text
 * (only status + GitLab's message are surfaced).
 */
async function gitlabFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "PRIVATE-TOKEN": token as string,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "kuclab-hertz-mcp-gitlab",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 500);
    try {
      detail = (JSON.parse(body) as { message?: string }).message ?? detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`GitLab API error ${res.status}: ${detail}`);
  }
  return body ? JSON.parse(body) : {};
}

const server = new McpServer({ name: "kuclab-hertz-gitlab", version: "0.1.0" });

const projectParam = z
  .union([z.number().int().positive(), z.string()])
  .describe("Project id (number) or URL-encoded path (e.g. 'group%2Fproject')");

server.registerTool(
  "gitlab_list_projects",
  {
    description: "List GitLab projects the token has access to.",
    inputSchema: {
      search: z.string().optional().describe("Filter by name or path"),
      owned: z.boolean().optional().default(true).describe("Only projects owned by the token's user"),
      perPage: z.number().int().positive().max(100).optional().default(20),
    },
  },
  async ({ search, owned, perPage }) => {
    const q = new URLSearchParams({ per_page: String(perPage), order_by: "last_activity_at" });
    if (search) q.set("search", search);
    if (owned) q.set("owned", "true");
    const projects: any[] = await gitlabFetch(`/projects?${q}`);
    if (projects.length === 0) return { content: [{ type: "text", text: "No projects found." }] };
    const text = projects
      .map((p) => `- ${p.path_with_namespace} (id ${p.id})${p.description ? ` — ${p.description}` : ""}\n  ${p.web_url}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "gitlab_list_issues",
  {
    description: "List issues of a GitLab project.",
    inputSchema: {
      project: projectParam,
      state: z.enum(["opened", "closed", "all"]).optional().default("opened"),
      perPage: z.number().int().positive().max(100).optional().default(20),
    },
  },
  async ({ project, state, perPage }) => {
    const id = encodeURIComponent(String(project));
    const issues: any[] = await gitlabFetch(`/projects/${id}/issues?state=${state}&per_page=${perPage}&order_by=updated_at`);
    if (issues.length === 0) return { content: [{ type: "text", text: "No issues found." }] };
    const text = issues
      .map((i) => `#${i.iid} [${i.state}] ${i.title} — ${i.author?.username ?? "?"}\n  ${i.web_url}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "gitlab_get_issue",
  {
    description: "Read a single GitLab issue including its description.",
    inputSchema: { project: projectParam, issueIid: z.number().int().positive() },
  },
  async ({ project, issueIid }) => {
    const id = encodeURIComponent(String(project));
    const i: any = await gitlabFetch(`/projects/${id}/issues/${issueIid}`);
    const text =
      `#${i.iid} [${i.state}] ${i.title}\n` +
      `Author: ${i.author?.username ?? "?"} · Labels: ${(i.labels ?? []).join(", ") || "none"}\n` +
      `${i.web_url}\n\n${i.description || "(no description)"}`;
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "gitlab_create_issue",
  {
    description: "Create a new issue in a GitLab project.",
    inputSchema: {
      project: projectParam,
      title: z.string().max(500),
      description: z.string().max(50_000).optional(),
    },
  },
  async ({ project, title, description }) => {
    const id = encodeURIComponent(String(project));
    const i: any = await gitlabFetch(`/projects/${id}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, description }),
    });
    return { content: [{ type: "text", text: `Created issue #${i.iid}: ${i.title}\n${i.web_url}` }] };
  },
);

server.registerTool(
  "gitlab_list_merge_requests",
  {
    description: "List merge requests of a GitLab project.",
    inputSchema: {
      project: projectParam,
      state: z.enum(["opened", "closed", "merged", "all"]).optional().default("opened"),
      perPage: z.number().int().positive().max(100).optional().default(20),
    },
  },
  async ({ project, state, perPage }) => {
    const id = encodeURIComponent(String(project));
    const mrs: any[] = await gitlabFetch(`/projects/${id}/merge_requests?state=${state}&per_page=${perPage}&order_by=updated_at`);
    if (mrs.length === 0) return { content: [{ type: "text", text: "No merge requests found." }] };
    const text = mrs
      .map((m) => `!${m.iid} [${m.state}] ${m.title} — ${m.author?.username ?? "?"}\n  ${m.web_url}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "gitlab_get_file",
  {
    description: "Read a file from a GitLab repository (decoded from base64).",
    inputSchema: {
      project: projectParam,
      path: z.string().describe("Repository path, e.g. 'README.md'"),
      ref: z.string().optional().default("main").describe("Branch, tag or commit"),
      maxChars: z.number().int().positive().max(200_000).optional().default(50_000),
    },
  },
  async ({ project, path, ref, maxChars }) => {
    const id = encodeURIComponent(String(project));
    const f: any = await gitlabFetch(`/projects/${id}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
    const decoded = Buffer.from(f.content ?? "", "base64").toString("utf-8");
    return { content: [{ type: "text", text: `File ${path} @ ${ref} (${decoded.length} chars):\n\n${decoded.slice(0, maxChars)}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
