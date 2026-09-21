#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const token = process.env.GITHUB_TOKEN;
/** Overridable for tests/QA — production default is the real GitHub API. */
const apiBase = (process.env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/$/, "");

if (!token) {
  console.error("mcp-github: missing GITHUB_TOKEN");
  process.exit(1);
}

/**
 * Every request goes through here so auth headers are set in exactly one
 * place — and so a failed call can never leak the token into the error text
 * (only status + GitHub's message are surfaced).
 */
async function githubFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "kuclab-hertz-mcp-github",
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
    throw new Error(`GitHub API error ${res.status}: ${detail}`);
  }
  return body ? JSON.parse(body) : {};
}

const server = new McpServer({ name: "kuclab-hertz-github", version: "0.1.0" });

server.registerTool(
  "github_search_repos",
  {
    description: "Search GitHub repositories by keyword.",
    inputSchema: {
      query: z.string().describe("Search keywords, e.g. 'mcp server language:typescript'"),
      perPage: z.number().int().positive().max(30).optional().default(10),
    },
  },
  async ({ query, perPage }) => {
    const res: any = await githubFetch(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}`);
    const items = res.items ?? [];
    if (items.length === 0) return { content: [{ type: "text", text: "No repositories matched." }] };
    const text = items
      .map((r: any) => `${r.full_name} — ${r.description ?? "(no description)"} (${r.stargazers_count ?? 0} stars) — ${r.html_url}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "github_list_issues",
  {
    description: "List issues of a repository.",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).optional().default("open"),
      perPage: z.number().int().positive().max(50).optional().default(10),
    },
  },
  async ({ owner, repo, state, perPage }) => {
    const res: any = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=${perPage}`,
    );
    if (!Array.isArray(res) || res.length === 0) return { content: [{ type: "text", text: "No issues found." }] };
    const text = res
      .filter((i: any) => !i.pull_request)
      .map((i: any) => `#${i.number} [${i.state}] ${i.title} — ${i.html_url}`)
      .join("\n");
    return { content: [{ type: "text", text: text || "No issues found." }] };
  },
);

server.registerTool(
  "github_create_issue",
  {
    description: "Create an issue in a repository.",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
      body: z.string().optional().describe("Issue body (markdown)"),
    },
  },
  async ({ owner, repo, title, body }) => {
    const res: any = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body: body ?? "" }),
    });
    return { content: [{ type: "text", text: `Created issue #${res.number}: ${res.title} — ${res.html_url}` }] };
  },
);

server.registerTool(
  "github_get_file",
  {
    description: "Read a file's content from a repository (text files, up to ~100 kB).",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      path: z.string().describe("File path in the repo, e.g. 'README.md'"),
      ref: z.string().optional().describe("Branch, tag or commit SHA (default: repo default branch)"),
    },
  },
  async ({ owner, repo, path, ref }) => {
    const res: any = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
    );
    if (res.type !== "file" || typeof res.content !== "string") {
      throw new Error(`github_get_file: "${path}" is not a file (got ${res.type ?? "unknown"})`);
    }
    const text = Buffer.from(res.content, "base64").toString("utf8").slice(0, 100_000);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "github_list_pull_requests",
  {
    description: "List pull requests of a repository.",
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).optional().default("open"),
      perPage: z.number().int().positive().max(30).optional().default(10),
    },
  },
  async ({ owner, repo, state, perPage }) => {
    const res: any = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=${perPage}`,
    );
    if (!Array.isArray(res) || res.length === 0) return { content: [{ type: "text", text: "No pull requests found." }] };
    const text = res.map((p: any) => `#${p.number} [${p.state}] ${p.title} (${p.head?.ref} → ${p.base?.ref}) — ${p.html_url}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
