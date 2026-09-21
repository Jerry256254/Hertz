import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * End-to-end test prezentačního konektoru přes skutečný MCP stdio server:
 * vytvoření prezentace (PPTX + HTML), přidání slidu, výpis, osnova, export.
 * Soubory se píšou do dočasného adresáře (PRESENTATION_OUTPUT_DIR).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-presentation-test-"));

let client;

function textOf(result) {
  return result.content.map((c) => c.text).join("\n");
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `tool ${name} failed: ${textOf(result)}`);
  return textOf(result);
}

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { PRESENTATION_OUTPUT_DIR: outDir },
  });
  client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client.close().catch(() => {});
  await fs.rm(outDir, { recursive: true, force: true });
});

describe("mcp-presentation", () => {
  it("registers the expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of ["presentation_create", "presentation_add_slide", "presentation_list", "presentation_get", "presentation_export"]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  });

  let deckId;

  it("presentation_create writes PPTX + HTML files", async () => {
    const text = await call("presentation_create", {
      title: "Testovací prezentace",
      subtitle: "Podtitul",
      theme: "light",
      slides: [
        { heading: "Úvod", body: "Krátký úvodní text.", bullets: ["první bod", "druhý bod"] },
        { heading: "Závěr", body: "Děkuji za pozornost." },
      ],
    });
    const idMatch = text.match(/ID: ([0-9a-f-]{36})/);
    assert.ok(idMatch, `no deck id in output: ${text}`);
    deckId = idMatch[1];

    const pptxMatch = text.match(/PPTX: (.+\.pptx)/);
    const htmlMatch = text.match(/HTML: (.+\.html)/);
    assert.ok(pptxMatch && htmlMatch, "output must contain PPTX and HTML paths");

    const pptxStat = await fs.stat(pptxMatch[1]);
    assert.ok(pptxStat.size > 5000, `PPTX suspiciously small: ${pptxStat.size} bytes`);
    // PPTX je ZIP — musí začínat PK
    const head = Buffer.alloc(2);
    const fh = await fs.open(pptxMatch[1], "r");
    await fh.read(head, 0, 2, 0);
    await fh.close();
    assert.equal(head.toString("ascii"), "PK", "PPTX is not a ZIP archive");

    const html = await fs.readFile(htmlMatch[1], "utf8");
    assert.ok(html.includes("Testovací prezentace"), "HTML must contain the title");
    assert.ok(html.includes("Úvod") && html.includes("Závěr"), "HTML must contain slide headings");
    assert.ok(html.includes("první bod"), "HTML must contain bullets");
  });

  it("presentation_add_slide appends and regenerates files", async () => {
    const before = (await fs.stat(path.join(outDir, deckId, "prezentace.pptx"))).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const text = await call("presentation_add_slide", {
      presentationId: deckId,
      slide: { heading: "Nový slid", bullets: ["nový bod"] },
    });
    assert.ok(text.includes("Nový slid"), "result must mention the new slide");
    const after = (await fs.stat(path.join(outDir, deckId, "prezentace.pptx"))).mtimeMs;
    assert.ok(after > before, "PPTX must be regenerated");

    const outline = await call("presentation_get", { presentationId: deckId });
    assert.ok(outline.includes("3. Nový slid"), `outline must list the new slide third: ${outline}`);
  });

  it("presentation_add_slide supports explicit position", async () => {
    await call("presentation_add_slide", {
      presentationId: deckId,
      slide: { heading: "Vložený slid" },
      position: 1,
    });
    const outline = await call("presentation_get", { presentationId: deckId });
    assert.ok(outline.includes("1. Vložený slid"), `inserted slide must be first: ${outline}`);
  });

  it("presentation_list shows the deck", async () => {
    const text = await call("presentation_list", {});
    assert.ok(text.includes(deckId), "list must contain the created deck");
    assert.ok(text.includes("Testovací prezentace"));
  });

  it("presentation_export returns the file path", async () => {
    const text = await call("presentation_export", { presentationId: deckId, format: "pptx" });
    assert.ok(text.includes(path.join(outDir, deckId, "prezentace.pptx")));
  });

  it("rejects unknown presentation ids", async () => {
    const result = await client.callTool({ name: "presentation_get", arguments: { presentationId: "neexistuje" } });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).match(/neexistuje/i));
  });

  it("rejects path traversal in presentation id", async () => {
    const result = await client.callTool({ name: "presentation_get", arguments: { presentationId: "../../etc" } });
    assert.equal(result.isError, true);
  });

  it("rejects empty slide list (zod validation)", async () => {
    const result = await client.callTool({ name: "presentation_create", arguments: { title: "Prázdná", slides: [] } });
    assert.equal(result.isError, true);
  });
});
