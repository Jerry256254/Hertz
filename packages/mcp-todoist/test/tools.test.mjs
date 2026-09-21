import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");

/** Minimal fake Todoist API v1 — asserts the Bearer token on every call. */
function startMockTodoist() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    assert.equal(req.headers.authorization, "Bearer dummy-token", "missing Bearer auth header");
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && u.pathname === "/api/v1/tasks") {
      return json(200, {
        results: [{ id: "t1", content: "Koupit mléko", priority: 2, due: { date: "2026-09-22" }, project_id: "p1" }],
      });
    }
    if (req.method === "GET" && u.pathname === "/api/v1/projects") {
      return json(200, { results: [{ id: "p1", name: "Osobní" }] });
    }
    if (req.method === "POST" && u.pathname === "/api/v1/tasks") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        assert.equal(parsed.content, "Nový úkol");
        assert.equal(parsed.due_string, "tomorrow");
        json(200, { id: "t2", content: parsed.content, priority: 1, project_id: "p1" });
      });
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/v1/tasks/t1/close") {
      res.writeHead(204);
      return res.end();
    }
    return json(404, { error: "not found in mock" });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

let client;
let mock;

before(async () => {
  mock = await startMockTodoist();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: {
      TODOIST_TOKEN: "dummy-token",
      TODOIST_API_ROOT: `http://127.0.0.1:${mock.port}/api/v1`,
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

describe("mcp-todoist", () => {
  it("registers all four tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["todoist_complete_task", "todoist_create_task", "todoist_list_projects", "todoist_list_tasks"]);
  });

  it("lists tasks", async () => {
    const text = await call("todoist_list_tasks", {});
    assert.match(text, /Koupit mléko/);
    assert.match(text, /2026-09-22/);
  });

  it("lists projects", async () => {
    const text = await call("todoist_list_projects", {});
    assert.match(text, /Osobní/);
  });

  it("creates a task", async () => {
    const text = await call("todoist_create_task", { content: "Nový úkol", projectId: "p1", dueString: "tomorrow" });
    assert.match(text, /Nový úkol/);
  });

  it("completes a task", async () => {
    const text = await call("todoist_complete_task", { taskId: "t1" });
    assert.match(text, /t1.*done/);
  });

  it("exits without TODOIST_TOKEN", async () => {
    const t = new StdioClientTransport({ command: process.execPath, args: [serverJs], env: {} });
    const c = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
    await assert.rejects(() => c.connect(t));
    await c.close().catch(() => {});
  });
});
