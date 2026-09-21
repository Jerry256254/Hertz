import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");

/** Minimal fake GitLab API v4 — asserts the PRIVATE-TOKEN header on every call. */
function startMockGitlab() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    assert.equal(req.headers["private-token"], "dummy-token", "missing PRIVATE-TOKEN auth header");
    seen.push(`${req.method} ${u.pathname}`);
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && u.pathname === "/api/v4/projects") {
      return json(200, [{ id: 42, path_with_namespace: "acme/web", description: "Web app", web_url: "https://gitlab.example/acme/web" }]);
    }
    if (req.method === "GET" && u.pathname === "/api/v4/projects/42/issues/7") {
      return json(200, { iid: 7, title: "Login bug", state: "opened", author: { username: "jara" }, labels: ["bug"], web_url: "https://gitlab.example/acme/web/-/issues/7", description: "Cannot log in." });
    }
    if (req.method === "GET" && u.pathname === "/api/v4/projects/42/issues") {
      return json(200, [{ iid: 7, title: "Login bug", state: "opened", author: { username: "jara" }, web_url: "https://gitlab.example/acme/web/-/issues/7" }]);
    }
    if (req.method === "POST" && u.pathname === "/api/v4/projects/42/issues") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        assert.equal(parsed.title, "New issue");
        json(201, { iid: 8, title: parsed.title, web_url: "https://gitlab.example/acme/web/-/issues/8" });
      });
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/v4/projects/42/merge_requests") {
      return json(200, [{ iid: 3, title: "Fix login", state: "opened", author: { username: "jara" }, web_url: "https://gitlab.example/acme/web/-/merge_requests/3" }]);
    }
    if (req.method === "GET" && u.pathname === "/api/v4/projects/42/repository/files/README.md") {
      return json(200, { content: Buffer.from("hello gitlab").toString("base64") });
    }
    return json(404, { message: "not found in mock" });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, seen }));
  });
}

let client;
let mock;

before(async () => {
  mock = await startMockGitlab();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: {
      GITLAB_TOKEN: "dummy-token",
      GITLAB_API_ROOT: `http://127.0.0.1:${mock.port}/api/v4`,
    },
  });
  client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client.close().catch(() => {});
  mock.srv.close();
});

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  return res.content.map((c) => c.text).join("\n");
}

describe("mcp-gitlab", () => {
  it("registers all six tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "gitlab_create_issue",
      "gitlab_get_file",
      "gitlab_get_issue",
      "gitlab_list_issues",
      "gitlab_list_merge_requests",
      "gitlab_list_projects",
    ]);
  });

  it("lists projects", async () => {
    const text = await call("gitlab_list_projects", {});
    assert.match(text, /acme\/web/);
    assert.match(text, /id 42/);
  });

  it("lists and reads issues", async () => {
    const list = await call("gitlab_list_issues", { project: 42 });
    assert.match(list, /#7.*Login bug/);
    const one = await call("gitlab_get_issue", { project: 42, issueIid: 7 });
    assert.match(one, /Cannot log in/);
  });

  it("creates an issue", async () => {
    const text = await call("gitlab_create_issue", { project: 42, title: "New issue", description: "desc" });
    assert.match(text, /#8/);
  });

  it("lists merge requests", async () => {
    const text = await call("gitlab_list_merge_requests", { project: 42 });
    assert.match(text, /!3.*Fix login/);
  });

  it("reads a repository file", async () => {
    const text = await call("gitlab_get_file", { project: 42, path: "README.md" });
    assert.match(text, /hello gitlab/);
  });

  it("exits without GITLAB_TOKEN", async () => {
    const t = new StdioClientTransport({ command: process.execPath, args: [serverJs], env: {} });
    const c = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
    await assert.rejects(() => c.connect(t));
    await c.close().catch(() => {});
  });
});
