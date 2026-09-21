import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Testovací zprávy</title>
    <item>
      <title><![CDATA[První zpráva &amp; úvod]]></title>
      <link>https://example.com/1</link>
      <pubDate>Mon, 21 Sep 2026 10:00:00 +0200</pubDate>
      <description><![CDATA[<p>Krátký <b>perex</b> první zprávy.</p>]]></description>
      <content:encoded><![CDATA[<p>Celý text první zprávy.</p>]]></content:encoded>
    </item>
    <item>
      <title>Druhá zpráva</title>
      <link>https://example.com/2</link>
      <pubDate>Mon, 21 Sep 2026 09:00:00 +0200</pubDate>
      <description>Stručný popis druhé zprávy.</description>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom kanál</title>
  <entry>
    <title>Atom položka</title>
    <link href="https://example.com/atom-1"/>
    <published>2026-09-21T08:00:00+02:00</published>
    <summary>Krátké shrnutí atom položky.</summary>
  </entry>
</feed>`;

function startMockFeeds() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
    if (req.url === "/rss.xml") return res.end(RSS_FIXTURE);
    if (req.url === "/atom.xml") return res.end(ATOM_FIXTURE);
    if (req.url === "/broken.xml") return res.end("<html><body>not a feed</body></html>");
    res.writeHead(404);
    res.end("nope");
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

let client;
let mock;

before(async () => {
  mock = await startMockFeeds();
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverJs], env: {} });
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

describe("mcp-rss", () => {
  it("registers the rss_read_feed tool", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["rss_read_feed"]);
  });

  it("parses RSS 2.0 incl. CDATA and namespaced content", async () => {
    const text = await call("rss_read_feed", { url: `http://127.0.0.1:${mock.port}/rss.xml` });
    assert.match(text, /Testovací zprávy/);
    assert.match(text, /První zpráva & úvod/);
    assert.match(text, /https:\/\/example\.com\/1/);
    assert.match(text, /Celý text první zprávy/); // content:encoded preferred over description
    assert.match(text, /Druhá zpráva/);
    assert.doesNotMatch(text, /<p>/); // HTML stripped
  });

  it("parses Atom feeds", async () => {
    const text = await call("rss_read_feed", { url: `http://127.0.0.1:${mock.port}/atom.xml` });
    assert.match(text, /Atom kanál/);
    assert.match(text, /Atom položka/);
    assert.match(text, /https:\/\/example\.com\/atom-1/);
  });

  it("respects the limit", async () => {
    const text = await call("rss_read_feed", { url: `http://127.0.0.1:${mock.port}/rss.xml`, limit: 1 });
    assert.match(text, /První zpráva/);
    assert.doesNotMatch(text, /Druhá zpráva/);
  });

  it("rejects non-feed documents", async () => {
    const res = await client.callTool({ name: "rss_read_feed", arguments: { url: `http://127.0.0.1:${mock.port}/broken.xml` } });
    assert.equal(res.isError, true);
    assert.match(res.content.map((c) => c.text).join("\n"), /RSS/);
  });

  it("rejects non-http(s) URLs", async () => {
    const res = await client.callTool({ name: "rss_read_feed", arguments: { url: "ftp://example.com/feed.xml" } });
    assert.equal(res.isError, true);
  });
});
