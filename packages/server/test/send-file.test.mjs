/**
 * Regression tests for agent file delivery (send_file end-to-end):
 *
 *  1. The `send_file` tool resolves paths through the real PathGuard
 *     (traversal attempts are refused), records the attachment in the DB and
 *     links it to the run's latest assistant message.
 *  2. The web API serves the stored file back by attachment id
 *     (project-scoped, no raw paths in the request).
 *  3. The Telegram driver delivers the file via multipart sendDocument.
 *
 * Runs against a real in-memory libsql database (hand-written bootstrap SQL
 * from migrate.ts), so the SQL is covered too.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import Fastify from "fastify";

import { runMigrations } from "../dist/db/migrate.js";
import * as schema from "../dist/db/schema.js";
import { newId } from "../dist/db/client.js";
import { PathGuard } from "../../sandbox/dist/path-guard.js";
import {
  formatBytesCs,
  mimeTypeForFilename,
  sanitizeFilename,
} from "../dist/files/attachments.js";
import { createFileTools } from "../dist/tools/file-tools.js";
import { registerAttachmentRoutes } from "../dist/routes/attachments.js";
import { ensureDefaultProject } from "../dist/projects/default-project.js";
import { TelegramDriver } from "../dist/channels/telegram.js";

let db;
let tmpRoot;

const now = () => new Date();

async function makeDb() {
  const client = createClient({ url: ":memory:" });
  await runMigrations(client);
  return drizzle(client, { schema });
}

/** Minimal FK chain: user → providerConfig → project → agent → session. */
async function seedChain(db, projectId) {
  const userId = newId();
  await db.insert(schema.users).values({ id: userId, email: `${userId}@t.cz`, passwordHash: "x", role: "user", createdAt: now() });
  const pcId = newId();
  await db.insert(schema.providerConfigs).values({
    id: pcId, userId, provider: "anthropic", label: "T", encryptedKey: "x", defaultModel: "m", createdAt: now(),
  });
  await db.insert(schema.projects).values({ id: projectId, name: "Osobní", createdAt: now() });
  await db.insert(schema.projectRoots).values({
    id: newId(), projectId, rootId: "main", label: "Pracovní složka", absolutePath: tmpRoot,
  });
  const agentId = newId();
  await db.insert(schema.agents).values({
    id: agentId, projectId, providerConfigId: pcId, name: "Orion", model: "m", createdAt: now(),
  });
  const sessionId = newId();
  await db.insert(schema.sessions).values({
    id: sessionId, agentId, projectId, title: "Test", createdAt: now(), updatedAt: now(),
  });
  return { userId, agentId, sessionId };
}

function toolCtx({ agentId, sessionId, projectId }) {
  return {
    actor: { actorId: agentId, actorType: "agent", sessionId, projectId, userId: "user-1" },
    rootId: "main",
    pathGuard: new PathGuard({ main: tmpRoot }),
    shellPolicy: {},
    audit: { record: () => {} },
    artifacts: {},
  };
}

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-sendfile-"));
  db = await makeDb();
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("attachment helpers", () => {
  it("detects MIME types by extension", () => {
    assert.equal(mimeTypeForFilename("zpráva.PDF"), "application/pdf");
    assert.equal(mimeTypeForFilename("foto.jpeg"), "image/jpeg");
    assert.equal(mimeTypeForFilename("data"), "application/octet-stream");
  });
  it("formats sizes in Czech", () => {
    assert.equal(formatBytesCs(512), "512 B");
    assert.equal(formatBytesCs(2048), "2,0 kB");
    assert.equal(formatBytesCs(5 * 1024 * 1024), "5,0 MB");
  });
  it("sanitizes filenames", () => {
    assert.equal(sanitizeFilename("../../../etc/passwd"), "passwd");
    assert.equal(sanitizeFilename("  zpráva.pdf  "), "zpráva.pdf");
    assert.equal(sanitizeFilename(""), "soubor");
  });
});

describe("send_file tool", () => {
  it("sends a file: guards the path, records the attachment, links the assistant message", async () => {
    const projectId = newId();
    const { agentId, sessionId } = await seedChain(db, projectId);
    const msgId = newId();
    await db.insert(schema.messages).values({
      id: msgId, sessionId, role: "assistant", content: "[]", senderAgentId: agentId, createdAt: now(),
    });

    const rel = "weby/landing/index.html";
    await fs.mkdir(path.join(tmpRoot, "weby/landing"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, rel), "<html>ahoj</html>");

    const [tool] = createFileTools(db);
    const result = await tool.execute({ path: rel, caption: "Náhled webu" }, toolCtx({ agentId, sessionId, projectId }));

    assert.equal(result.isError, undefined);
    assert.match(result.summary, /index\.html/);
    assert.ok(result.fileAttachment, "tool result carries the attachment payload");
    assert.equal(result.fileAttachment.filename, "index.html");
    assert.equal(result.fileAttachment.caption, "Náhled webu");

    const rows = await db.select().from(schema.messageAttachments).where(eq(schema.messageAttachments.id, result.fileAttachment.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messageId, msgId, "attachment is linked to the run's assistant message");
    assert.equal(rows[0].mimeType, "text/html");
    assert.ok(rows[0].absolutePath.startsWith(tmpRoot));
  });

  it("refuses path traversal — nothing is recorded", async () => {
    const projectId = newId();
    const { agentId, sessionId } = await seedChain(db, projectId);
    const before = await db.select({ id: schema.messageAttachments.id }).from(schema.messageAttachments);

    const [tool] = createFileTools(db);
    const result = await tool.execute({ path: "../../etc/passwd" }, toolCtx({ agentId, sessionId, projectId }));

    assert.equal(result.isError, true);
    const after = await db.select({ id: schema.messageAttachments.id }).from(schema.messageAttachments);
    assert.equal(after.length, before.length);
  });

  it("rejects missing files and directories", async () => {
    const projectId = newId();
    const { agentId, sessionId } = await seedChain(db, projectId);
    const [tool] = createFileTools(db);
    const missing = await tool.execute({ path: "neexistuje.txt" }, toolCtx({ agentId, sessionId, projectId }));
    assert.equal(missing.isError, true);
    await fs.mkdir(path.join(tmpRoot, "slozka"), { recursive: true });
    const dir = await tool.execute({ path: "slozka" }, toolCtx({ agentId, sessionId, projectId }));
    assert.equal(dir.isError, true);
  });

  it("rejects files over the 50 MB limit", async () => {
    const projectId = newId();
    const { agentId, sessionId } = await seedChain(db, projectId);
    const big = path.join(tmpRoot, "velky.bin");
    await fs.writeFile(big, "x");
    await fs.truncate(big, 51 * 1024 * 1024); // sparse — instant, no real disk use
    const [tool] = createFileTools(db);
    const result = await tool.execute({ path: "velky.bin" }, toolCtx({ agentId, sessionId, projectId }));
    assert.equal(result.isError, true);
    assert.match(result.summary, /maximum je 50/);
  });
});

describe("attachment download route", () => {
  let app;
  let projectId;
  let sessionId;
  let attachmentId;
  const fileBytes = Buffer.from("tajný obsah souboru");

  before(async () => {
    projectId = newId();
    ({ sessionId } = await seedChain(db, projectId));
    attachmentId = newId();
    const abs = path.join(tmpRoot, "report.pdf");
    await fs.writeFile(abs, fileBytes);
    await db.insert(schema.messageAttachments).values({
      id: attachmentId,
      sessionId,
      messageId: null,
      filename: "report.pdf",
      size: fileBytes.length,
      mimeType: "application/pdf",
      absolutePath: abs,
      caption: "Měsíční report",
      createdAt: now(),
    });

    app = Fastify();
    app.addHook("preHandler", (req, _reply, done) => {
      req.user = { id: "admin-1", role: "admin" };
      done();
    });
    registerAttachmentRoutes(app, { db });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("returns the file bytes with download headers", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/attachments/${attachmentId}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/pdf");
    assert.match(res.headers["content-disposition"] ?? "", /^attachment;/);
    assert.ok((res.headers["content-disposition"] ?? "").includes("report.pdf"));
    assert.equal(res.body, fileBytes.toString());
  });

  it("404s unknown attachments and foreign-project attachments", async () => {
    const missing = await app.inject({ method: "GET", url: `/api/projects/${projectId}/attachments/${newId()}` });
    assert.equal(missing.statusCode, 404);
    const otherProject = newId();
    await seedChain(db, otherProject);
    const foreign = await app.inject({ method: "GET", url: `/api/projects/${otherProject}/attachments/${attachmentId}` });
    assert.equal(foreign.statusCode, 404);
  });

  it("403s a user without access to the project", async () => {
    const app2 = Fastify();
    app2.addHook("preHandler", (req, _reply, done) => {
      req.user = { id: "stranger", role: "user" };
      done();
    });
    registerAttachmentRoutes(app2, { db });
    await app2.ready();
    try {
      const res = await app2.inject({ method: "GET", url: `/api/projects/${projectId}/attachments/${attachmentId}` });
      assert.equal(res.statusCode, 403);
    } finally {
      await app2.close();
    }
  });
});

describe("ensureDefaultProject (no project picker in the product)", () => {
  it("creates the implicit workspace on a fresh install", async () => {
    const client = createClient({ url: ":memory:" });
    await runMigrations(client);
    const freshDb = drizzle(client, { schema });
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-datadir-"));
    try {
      const id = await ensureDefaultProject({ db: freshDb, paths: { dataDir } });
      const rows = await freshDb.select().from(schema.projects).where(eq(schema.projects.id, id));
      assert.equal(rows.length, 1);
      const roots = await freshDb.select().from(schema.projectRoots).where(eq(schema.projectRoots.projectId, id));
      assert.equal(roots.length, 1);
      assert.equal(roots[0].rootId, "main");
      const stat = await fs.stat(roots[0].absolutePath);
      assert.ok(stat.isDirectory());
      // Second call returns the same project — no duplicates.
      assert.equal(await ensureDefaultProject({ db: freshDb, paths: { dataDir } }), id);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps the oldest existing project (nobody's files move)", async () => {
    const first = newId();
    const second = newId();
    await db.insert(schema.projects).values({ id: first, name: "Starý", createdAt: new Date(1000) });
    await db.insert(schema.projects).values({ id: second, name: "Nový", createdAt: new Date(2000) });
    const id = await ensureDefaultProject({ db, paths: { dataDir: tmpRoot } });
    assert.equal(id, first);
  });
});

describe("telegram sendDocument", () => {
  let realFetch;
  let calls;

  before(() => {
    realFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    };
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  it("posts multipart sendDocument with chat_id, caption and the file", async () => {
    const abs = path.join(tmpRoot, "prezentace.pptx");
    await fs.writeFile(abs, "fake-pptx-bytes");
    const driver = new TelegramDriver("TESTTOKEN123");
    // Resolves (does not throw) on Telegram ok — the driver throws on failure.
    await driver.sendDocument("telegram:777", {
      absolutePath: abs,
      filename: "prezentace.pptx",
      caption: "Prezentace k narozeninám",
    });
    assert.equal(calls.length, 1);
    const [{ url, opts }] = calls;
    assert.ok(url.endsWith("/sendDocument"), `unexpected url ${url}`);
    assert.ok(url.includes("TESTTOKEN123"));
    const form = opts.body;
    assert.equal(form.get("chat_id"), "777");
    assert.equal(form.get("caption"), "Prezentace k narozeninám");
    const doc = form.get("document");
    assert.ok(doc instanceof File, "document is a File");
    assert.equal(doc.name, "prezentace.pptx");
    assert.equal(doc.type, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    assert.equal(await doc.text(), "fake-pptx-bytes");
  });

  it("omits the caption field when none is given", async () => {
    calls.length = 0;
    const abs = path.join(tmpRoot, "foto.png");
    await fs.writeFile(abs, "fake-png");
    const driver = new TelegramDriver("TESTTOKEN123");
    await driver.sendDocument("telegram:888", { absolutePath: abs, filename: "foto.png" });
    const form = calls[0].opts.body;
    assert.equal(form.get("chat_id"), "888");
    assert.equal(form.has("caption"), false);
  });

  it("throws when Telegram reports failure", async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: "Bad Request" }) });
    const abs = path.join(tmpRoot, "foto.png");
    const driver = new TelegramDriver("TESTTOKEN123");
    await assert.rejects(
      driver.sendDocument("telegram:888", { absolutePath: abs, filename: "foto.png" }),
      /sendDocument failed/,
    );
  });
});
