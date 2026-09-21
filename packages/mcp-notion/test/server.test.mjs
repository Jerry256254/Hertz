import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");

const seen = { auth: [], notionVersion: [] };

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
  seen.auth.push(req.headers.authorization ?? "");
  seen.notionVersion.push(req.headers["notion-version"] ?? "");
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.headers.authorization !== "Bearer test-key") return json(401, { message: "unauthorized" });

  if (url.pathname === "/v1/search" && req.method === "POST") {
    return json(200, {
      results: [
        { id: "page-1", object: "page", url: "https://notion.so/page-1", properties: { title: { type: "title", title: [{ plain_text: "Poznámky" }] } } },
        { id: "db-1", object: "database", url: "https://notion.so/db-1", properties: { title: { type: "title", title: [{ plain_text: "Úkoly" }] } } },
      ],
      has_more: false,
    });
  }
  if (url.pathname === "/v1/pages/page-1" && req.method === "GET") {
    return json(200, { id: "page-1", properties: { title: { type: "title", title: [{ plain_text: "Poznámky" }] } } });
  }
  if (url.pathname === "/v1/blocks/page-1/children" && req.method === "GET") {
    return json(200, {
      results: [
        { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Nadpis" }] } },
        { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Odstavec textu." }] } },
        { type: "to_do", to_do: { rich_text: [{ plain_text: "Úkol" }], checked: true } },
      ],
      has_more: false,
    });
  }
  if (url.pathname === "/v1/databases/db-1/query" && req.method === "POST") {
    return json(200, {
      results: [
        { id: "row-1", properties: { Název: { type: "title", title: [{ plain_text: "První úkol" }] }, Stav: { type: "select", select: { name: "Hotovo" } } } },
      ],
      has_more: false,
    });
  }
  if (url.pathname === "/v1/databases/db-1" && req.method === "GET") {
    return json(200, { id: "db-1", properties: { Název: { type: "title", title: {} } } });
  }
  if (url.pathname === "/v1/pages" && req.method === "POST") {
    const parsed = JSON.parse(body);
    assert.ok(parsed.parent, "page create must include parent");
    return json(200, { id: "page-new", url: "https://notion.so/page-new" });
  }
  res.writeHead(404);
  res.end("no mock");
});

let base = "";
let client;

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text, isError: Boolean(res.isError) };
}

before(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${mock.address().port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { NOTION_API_KEY: "test-key", NOTION_API_BASE: base },
  });
  client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client.close().catch(() => {});
  await new Promise((r) => mock.close(r));
});

describe("mcp-notion", () => {
  it("exposes the four notion tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["notion_create_page", "notion_get_page", "notion_query_database", "notion_search"]);
  });

  it("notion_search returns pages and databases", async () => {
    const { text, isError } = await callTool("notion_search", { query: "pozn" });
    assert.equal(isError, false);
    assert.ok(text.includes("Poznámky"));
    assert.ok(text.includes("Úkoly"));
  });

  it("notion_get_page returns title and block text", async () => {
    const { text, isError } = await callTool("notion_get_page", { pageId: "page-1" });
    assert.equal(isError, false);
    assert.ok(text.includes("Poznámky"));
    assert.ok(text.includes("# Nadpis"));
    assert.ok(text.includes("Odstavec textu."));
    assert.ok(text.includes("[x] Úkol"));
  });

  it("notion_query_database flattens row properties", async () => {
    const { text, isError } = await callTool("notion_query_database", { databaseId: "db-1" });
    assert.equal(isError, false);
    assert.ok(text.includes("První úkol"));
    assert.ok(text.includes("Hotovo"));
  });

  it("notion_create_page detects the database title property", async () => {
    const { text, isError } = await callTool("notion_create_page", {
      parentId: "db-1",
      parentType: "database",
      title: "Nový úkol",
      content: "Popis úkolu.",
    });
    assert.equal(isError, false);
    assert.ok(text.includes("page-new"));
  });

  it("sends Notion-Version and never leaks the key in errors", async () => {
    await callTool("notion_get_page", { pageId: "page-1" });
    assert.ok(seen.notionVersion.every((v) => v === "2022-06-28"));
    assert.ok(seen.auth.every((a) => a === "Bearer test-key"));
  });

  it("surfaces provider errors without the key", async () => {
    const { isError, text } = await callTool("notion_get_page", { pageId: "does-not-exist" });
    assert.equal(isError, true);
    assert.ok(!text.includes("test-key"), "error text must not contain the API key");
  });
});
