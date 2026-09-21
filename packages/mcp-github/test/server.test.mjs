import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");

const seenAuth = [];

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const body = await readBody(req);
  seenAuth.push(req.headers.authorization ?? "");
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.headers.authorization !== "Bearer test-token") return json(401, { message: "Bad credentials" });

  if (url.pathname === "/search/repositories" && req.method === "GET") {
    return json(200, {
      items: [
        { full_name: "octo/repo", description: "Test repo", stargazers_count: 42, html_url: "https://github.com/octo/repo" },
      ],
    });
  }
  if (url.pathname === "/repos/octo/repo/issues" && req.method === "GET") {
    return json(200, [{ number: 7, title: "Bug report", state: "open", html_url: "https://github.com/octo/repo/issues/7" }]);
  }
  if (url.pathname === "/repos/octo/repo/issues" && req.method === "POST") {
    const parsed = JSON.parse(body);
    return json(201, { number: 8, title: parsed.title, html_url: "https://github.com/octo/repo/issues/8" });
  }
  if (url.pathname === "/repos/octo/repo/contents/README.md" && req.method === "GET") {
    return json(200, { type: "file", content: Buffer.from("# Hello\nTest content").toString("base64") });
  }
  if (url.pathname === "/repos/octo/repo/pulls" && req.method === "GET") {
    return json(200, [{ number: 3, title: "Fix thing", state: "open", head: { ref: "fix" }, base: { ref: "main" }, html_url: "https://github.com/octo/repo/pull/3" }]);
  }
  res.writeHead(404);
  res.end("no mock");
});

let client;

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text, isError: Boolean(res.isError) };
}

before(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { GITHUB_TOKEN: "test-token", GITHUB_API_BASE: base },
  });
  client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client.close().catch(() => {});
  await new Promise((r) => mock.close(r));
});

describe("mcp-github", () => {
  it("exposes the five github tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["github_create_issue", "github_get_file", "github_list_issues", "github_list_pull_requests", "github_search_repos"]);
  });

  it("github_search_repos lists repositories", async () => {
    const { text, isError } = await callTool("github_search_repos", { query: "test" });
    assert.equal(isError, false);
    assert.ok(text.includes("octo/repo"));
    assert.ok(text.includes("42 stars"));
  });

  it("github_list_issues lists issues", async () => {
    const { text, isError } = await callTool("github_list_issues", { owner: "octo", repo: "repo" });
    assert.equal(isError, false);
    assert.ok(text.includes("#7"));
    assert.ok(text.includes("Bug report"));
  });

  it("github_create_issue creates an issue", async () => {
    const { text, isError } = await callTool("github_create_issue", { owner: "octo", repo: "repo", title: "New bug", body: "Details" });
    assert.equal(isError, false);
    assert.ok(text.includes("#8"));
  });

  it("github_get_file decodes file content", async () => {
    const { text, isError } = await callTool("github_get_file", { owner: "octo", repo: "repo", path: "README.md" });
    assert.equal(isError, false);
    assert.ok(text.includes("Test content"));
  });

  it("github_list_pull_requests lists PRs", async () => {
    const { text, isError } = await callTool("github_list_pull_requests", { owner: "octo", repo: "repo" });
    assert.equal(isError, false);
    assert.ok(text.includes("#3"));
    assert.ok(text.includes("fix → main"));
  });

  it("auth header is always the bearer token, errors never leak it", async () => {
    assert.ok(seenAuth.length > 0 && seenAuth.every((a) => a === "Bearer test-token"));
    const { isError, text } = await callTool("github_get_file", { owner: "octo", repo: "nope", path: "x" });
    assert.equal(isError, true);
    assert.ok(!text.includes("test-token"), "error text must not contain the token");
  });
});
