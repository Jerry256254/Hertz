import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");

/** Minimal fake Google Slides API v1 (routed via GOOGLE_API_ROOT_URL). */
function startMockSlides() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(`${req.method} ${u.pathname}`);
      if (req.method === "POST" && u.pathname === "/v1/presentations") {
        return json(200, { presentationId: "pres-1", title: JSON.parse(body).title });
      }
      if (req.method === "GET" && u.pathname === "/v1/presentations/pres-1") {
        if (u.searchParams.has("fields")) {
          // Second GET inside slides_add_slide: placeholders of the new slide.
          return json(200, {
            slides: [
              {
                objectId: "slide-2",
                pageElements: [
                  { objectId: "title-ph", shape: { placeholder: { type: "TITLE" } } },
                  { objectId: "body-ph", shape: { placeholder: { type: "BODY" } } },
                ],
              },
            ],
          });
        }
        return json(200, {
          title: "Testovací prezentace",
          slides: [
            {
              pageElements: [
                { shape: { text: { textElements: [{ textRun: { content: "Hello " } }, { textRun: { content: "world" } }] } } },
              ],
            },
            { pageElements: [] },
          ],
        });
      }
      if (req.method === "POST" && u.pathname === "/v1/presentations/pres-1:batchUpdate") {
        const parsed = JSON.parse(body);
        const first = parsed.requests[0];
        if (first.createSlide) return json(200, { replies: [{ createSlide: { objectId: "slide-2" } }] });
        if (first.insertText) {
          assert.equal(parsed.requests.length, 2, "title + body insertText expected");
          assert.equal(parsed.requests[0].insertText.objectId, "title-ph");
          assert.equal(parsed.requests[0].insertText.text, "Nový nadpis");
          assert.equal(parsed.requests[1].insertText.objectId, "body-ph");
          return json(200, { replies: [{}, {}] });
        }
      }
      return json(404, { error: { message: "not found in mock" } });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, seen }));
  });
}

let client;
let mock;

before(async () => {
  mock = await startMockSlides();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: {
      GOOGLE_CLIENT_ID: "cid",
      GOOGLE_CLIENT_SECRET: "sec",
      GOOGLE_ACCESS_TOKEN: "mock-access-token",
      GOOGLE_REFRESH_TOKEN: "rt",
      GOOGLE_ENABLED_APIS: "slides",
      GOOGLE_API_ROOT_URL: `http://127.0.0.1:${mock.port}/`,
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
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  return res.content.map((c) => c.text).join("\n");
}

describe("mcp-google slides (mock API)", () => {
  it("only slides tools are registered when GOOGLE_ENABLED_APIS=slides", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["slides_add_slide", "slides_create_presentation", "slides_get_presentation"]);
  });

  it("creates a presentation", async () => {
    const text = await call("slides_create_presentation", { title: "Moje prezentace" });
    assert.match(text, /pres-1/);
  });

  it("reads a presentation with slide texts", async () => {
    const text = await call("slides_get_presentation", { presentationId: "pres-1" });
    assert.match(text, /Testovací prezentace/);
    assert.match(text, /2 slides/);
    assert.match(text, /Hello world/);
    assert.match(text, /empty slide/);
  });

  it("adds a slide and inserts title + body into placeholders", async () => {
    const text = await call("slides_add_slide", { presentationId: "pres-1", title: "Nový nadpis", body: "Obsah slidu" });
    assert.match(text, /slide-2/);
    assert.ok(mock.seen.some((s) => s.includes(":batchUpdate")), `batchUpdate not called; saw: ${mock.seen.join(",")}`);
  });
});
