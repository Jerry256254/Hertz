import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { agents, approvals, providerConfigs, projects, sessions, users } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import { createHostAccessTools, executeHostAccessOp, formatHostAccessExecutedInbound, formatHostAccessRejectedInbound, parseHostAccessPayload, hostAccessInputSchema } from "../dist/tools/host-access-tools.js";
import { decideApproval } from "../dist/tools/approval-tools.js";
import { assertInside } from "../dist/paths.js";
import { buildSystemPrompt } from "../dist/agents/system-prompt.js";
import { createDesktopTools } from "../dist/tools/desktop-tools.js";
import { PathGuard } from "../../sandbox/dist/path-guard.js";
import { loadDefaultPolicy } from "../../sandbox/dist/shell-policy.js";
import { shellExecTool, readFileTool, writeFileTool, editFileTool, globTool, grepTool } from "../../tools/dist/index.js";
import { isPathLikeArg, scanShellArgs } from "../../tools/dist/shell/path-args.js";

const actor = { actorId: "agent-1", actorType: "agent", sessionId: "sess-1", projectId: "proj-1" };

async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-host-access-"));
  const { client, db } = openDatabase(path.join(dir, "test.db"));
  await runMigrations(client);
  return { client, db, dir };
}

/** FKs are enforced — seed the user/project/provider/agent/session chain. */
async function seedRun(db) {
  const now = new Date();
  await db.insert(users).values({ id: "user-1", email: "u@x.y", passwordHash: "h", role: "admin", createdAt: now });
  await db.insert(projects).values({ id: "proj-1", name: "p", createdAt: now });
  await db.insert(providerConfigs).values({ id: "pc-1", userId: "user-1", provider: "openai", label: "l", encryptedKey: "k", createdAt: now });
  await db.insert(agents).values({ id: "agent-1", projectId: "proj-1", name: "Orion", providerConfigId: "pc-1", model: "m", createdAt: now });
  await db.insert(sessions).values({ id: "sess-1", agentId: "agent-1", projectId: "proj-1", title: "t", status: "active", createdAt: now, updatedAt: now });
}

describe("approvals data model (A1)", () => {
  it("bootstrap creates kind/payload/result columns + session index", async () => {
    const { client } = await makeDb();
    const cols = await client.execute("PRAGMA table_info(approvals)");
    const names = cols.rows.map((r) => r.name);
    assert.ok(names.includes("kind"), "kind column missing");
    assert.ok(names.includes("payload"), "payload column missing");
    assert.ok(names.includes("result"), "result column missing");
    const idx = await client.execute("PRAGMA index_list(approvals)");
    const idxNames = idx.rows.map((r) => r.name);
    assert.ok(idxNames.includes("idx_approvals_session"), "idx_approvals_session missing");
    client.close();
  });

  it("old-shape DBs gain the columns via ALTER TABLE", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-migrate-"));
    const { createClient } = await import("@libsql/client");
    const legacy = createClient({ url: `file:${path.join(dir, "legacy.db")}` });
    await legacy.execute("CREATE TABLE approvals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_by_user_id TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)");
    await legacy.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL)");
    legacy.close();
    const { client } = openDatabase(path.join(dir, "legacy.db"));
    await runMigrations(client);
    const cols = await client.execute("PRAGMA table_info(approvals)");
    const names = cols.rows.map((r) => r.name);
    assert.ok(names.includes("kind") && names.includes("payload") && names.includes("result"));
    client.close();
  });
});

describe("request_host_access tool (A2)", () => {
  it("files a host_access approval and parks the run via awaitUser", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const [tool] = createHostAccessTools(db);
    const res = await tool.execute({ op: "read", hostPath: "/tmp/notes.txt", reason: "need the deploy checklist" }, { actor });
    assert.ok(res.awaitUser, "must park the run");
    assert.match(res.summary, /Host-access request filed/);
    const rows = await db.select().from(approvals);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "host_access");
    const payload = parseHostAccessPayload(rows[0].payload);
    assert.deepEqual(payload, { op: "read", hostPath: "/tmp/notes.txt", content: undefined, reason: "need the deploy checklist" });
    const sess = await db.select().from(sessions).where(eq(sessions.id, "sess-1"));
    const meta = JSON.parse(sess[0].metadata);
    assert.equal(meta.pendingApprovalId, rows[0].id);
    client.close();
  });

  it("rejects relative hostPath, short reason, missing content", () => {
    assert.throws(() => hostAccessInputSchema.parse({ op: "read", hostPath: "rel/path", reason: "long enough reason" }));
    assert.throws(() => hostAccessInputSchema.parse({ op: "read", hostPath: "/abs", reason: "short" }));
    assert.throws(() => hostAccessInputSchema.parse({ op: "rewrite", hostPath: "/abs/f", reason: "long enough reason" }));
    assert.throws(() => hostAccessInputSchema.parse({ op: "create", hostPath: "/abs/f", reason: "long enough reason" }));
    const ok = hostAccessInputSchema.parse({ op: "create", hostPath: "/abs/f", content: "x", reason: "long enough reason" });
    assert.equal(ok.op, "create");
  });
});

describe("host op execution (A3)", () => {
  let tmp;
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-hostop-"));
    await fs.writeFile(path.join(tmp, "a.txt"), "hello\n");
    await fs.mkdir(path.join(tmp, "empty"));
    await fs.mkdir(path.join(tmp, "full"));
    await fs.writeFile(path.join(tmp, "full", "x.txt"), "x");
  });

  it("read returns content; refuses oversize files and directories", async () => {
    const ok = await executeHostAccessOp({ op: "read", hostPath: path.join(tmp, "a.txt"), reason: "r" });
    assert.ok(ok.ok && ok.output === "hello\n" && ok.bytes === 6);
    const big = path.join(tmp, "big.bin");
    await fs.writeFile(big, Buffer.alloc(5_000_001, 1));
    const tooBig = await executeHostAccessOp({ op: "read", hostPath: big, reason: "r" });
    assert.ok(!tooBig.ok && /too large/i.test(tooBig.error));
    const dir = await executeHostAccessOp({ op: "read", hostPath: path.join(tmp, "full"), reason: "r" });
    assert.ok(!dir.ok);
    const missing = await executeHostAccessOp({ op: "read", hostPath: path.join(tmp, "nope"), reason: "r" });
    assert.ok(!missing.ok);
  });

  it("rewrite overwrites existing files only", async () => {
    const target = path.join(tmp, "rw.txt");
    await fs.writeFile(target, "old");
    const ok = await executeHostAccessOp({ op: "rewrite", hostPath: target, content: "new", reason: "r" });
    assert.ok(ok.ok && ok.bytes === 3);
    assert.equal(await fs.readFile(target, "utf8"), "new");
    const missing = await executeHostAccessOp({ op: "rewrite", hostPath: path.join(tmp, "ghost.txt"), content: "n", reason: "r" });
    assert.ok(!missing.ok && /does not exist/.test(missing.error));
    const noContent = await executeHostAccessOp({ op: "rewrite", hostPath: target, reason: "r" });
    assert.ok(!noContent.ok);
  });

  it("create writes new files only when the parent exists", async () => {
    const target = path.join(tmp, "created.txt");
    const ok = await executeHostAccessOp({ op: "create", hostPath: target, content: "hi", reason: "r" });
    assert.ok(ok.ok);
    const again = await executeHostAccessOp({ op: "create", hostPath: target, content: "hi", reason: "r" });
    assert.ok(!again.ok && /already exists/.test(again.error));
    const orphan = await executeHostAccessOp({ op: "create", hostPath: path.join(tmp, "nodir", "f.txt"), content: "hi", reason: "r" });
    assert.ok(!orphan.ok && /parent/.test(orphan.error));
  });

  it("delete removes files and empty dirs, never recursive", async () => {
    const f = path.join(tmp, "del.txt");
    await fs.writeFile(f, "bye");
    assert.ok((await executeHostAccessOp({ op: "delete", hostPath: f, reason: "r" })).ok);
    assert.ok((await executeHostAccessOp({ op: "delete", hostPath: path.join(tmp, "empty"), reason: "r" })).ok);
    const full = await executeHostAccessOp({ op: "delete", hostPath: path.join(tmp, "full"), reason: "r" });
    assert.ok(!full.ok, "non-empty dir must be refused");
    assert.equal(await fs.readFile(path.join(tmp, "full", "x.txt"), "utf8"), "x");
    const missing = await executeHostAccessOp({ op: "delete", hostPath: path.join(tmp, "gone"), reason: "r" });
    assert.ok(!missing.ok);
  });

  it("formats executed/rejected inbound text with truncation marker", () => {
    const big = "y".repeat(20_000);
    const text = formatHostAccessExecutedInbound({ op: "read", hostPath: "/h/f", reason: "why" }, { ok: true, output: big, bytes: 20000 });
    assert.ok(text.includes("[truncated 8000 bytes]"));
    assert.ok(!text.includes("y".repeat(20_000)));
    const fail = formatHostAccessExecutedInbound({ op: "delete", hostPath: "/h/f", reason: "why" }, { ok: false, error: "boom" });
    assert.ok(fail.includes("FAILED") && fail.includes("boom"));
    const rej = formatHostAccessRejectedInbound({ op: "read", hostPath: "/h/f", reason: "because reasons here" });
    assert.ok(rej.includes("REJECTED") && rej.includes("Do not retry"));
  });
});

describe("approval round-trip + double-decide safety", () => {
  it("decideApproval returns kind+payload; second decide is a no-op", async () => {
    const { client, db } = await makeDb();
    await seedRun(db);
    const [tool] = createHostAccessTools(db);
    await tool.execute({ op: "delete", hostPath: "/tmp/old.log", reason: "stale log cleanup request" }, { actor });
    const pending = await db.select().from(approvals);
    const first = await decideApproval(db, pending[0].id, "approved", "user-1");
    assert.ok(first);
    assert.equal(first.kind, "host_access");
    assert.ok(parseHostAccessPayload(first.payload));
    // Persist + read back an execution result like the route does.
    await db.update(approvals).set({ result: JSON.stringify({ ok: true }) }).where(eq(approvals.id, pending[0].id));
    const again = await decideApproval(db, pending[0].id, "rejected", "user-1");
    assert.equal(again, undefined);
    const stored = await db.select().from(approvals).where(eq(approvals.id, pending[0].id));
    assert.equal(stored[0].status, "approved");
    assert.equal(stored[0].result, JSON.stringify({ ok: true }));
    client.close();
  });
});

describe("root enforcement (A4)", () => {
  let root;
  let guard;
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-root-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "x");
    guard = new PathGuard({ main: root });
  });

  it("flags path-like args, ignores plain flags/words", () => {
    assert.ok(isPathLikeArg("src/a.ts"));
    assert.ok(isPathLikeArg("../../etc/passwd"));
    assert.ok(isPathLikeArg("/etc/passwd"));
    assert.ok(isPathLikeArg("--output=/tmp/x"));
    assert.ok(!isPathLikeArg("--verbose"));
    assert.ok(!isPathLikeArg("-rf"));
    assert.ok(!isPathLikeArg("hello"));
  });

  it("scanShellArgs blocks escapes, allows in-root paths", () => {
    assert.ok(scanShellArgs(guard, actor, "main", ["src/a.ts"]) === undefined);
    assert.ok(scanShellArgs(guard, actor, "main", ["--verbose", "hello"]) === undefined);
    assert.ok(scanShellArgs(guard, actor, "main", ["https://example.com/x"]) === undefined);
    const up = scanShellArgs(guard, actor, "main", ["../../etc/passwd"]);
    assert.ok(up, "rm ../../etc/x must be blocked");
    const abs = scanShellArgs(guard, actor, "main", ["/etc/passwd"]);
    assert.ok(abs, "absolute host paths outside the root must be blocked");
    const flag = scanShellArgs(guard, actor, "main", ["--output=/etc/shadow"]);
    assert.ok(flag, "--flag=/abs forms must be scanned");
    const inRoot = scanShellArgs(guard, actor, "main", [path.join(root, "src", "a.ts")]);
    assert.ok(inRoot === undefined, "absolute paths inside the root are allowed");
  });

  it("shell_exec blocks escaping args end-to-end", async () => {
    const ctx = { actor, rootId: "main", pathGuard: guard, shellPolicy: loadDefaultPolicy(), audit: { record() {} }, artifacts: { async store() { return "a"; } } };
    const blocked = await shellExecTool.execute({ command: "rm", args: ["../../etc/passwd"], cwd: "." }, ctx);
    assert.ok(blocked.isError && /escapes the project root/.test(blocked.summary));
    const ok = await shellExecTool.execute({ command: "echo", args: ["hello"], cwd: "." }, ctx);
    assert.ok(!ok.isError && ok.summary.includes("hello"));
  });

  it("assertInside contains home paths", () => {
    assert.equal(assertInside(root, path.join(root, "notes", "a.md")), path.join(root, "notes", "a.md"));
    assert.throws(() => assertInside(root, path.join(root, "..", "evil")), /escapes/);
    assert.throws(() => assertInside(root, "/etc/passwd"), /escapes/);
  });
});

describe("isolation prompt + text-tool guardrails", () => {
  it("system prompt carries the Your-computer block", async () => {
    const prompt = await buildSystemPrompt(undefined, { id: "a", systemPrompt: "base" }, { mode: "autonomous" });
    assert.ok(prompt.includes("## Your computer"));
    assert.ok(prompt.includes("request_host_access"));
    assert.ok(prompt.includes("unreachable"));
  });

  it("terminal/file tools are labelled text-only; desktop open_app forbids terminal strategy", () => {
    for (const tool of [shellExecTool, readFileTool, writeFileTool, editFileTool, globTool, grepTool]) {
      assert.ok(tool.description.includes("Text tool"), `${tool.name} missing Text-tool label`);
      assert.ok(tool.description.includes("never use desktop_"), `${tool.name} missing guardrail`);
    }
    const desktopTools = createDesktopTools({}, Buffer.alloc(32), {});
    const openApp = desktopTools.find((t) => t.name === "desktop_open_app");
    assert.ok(openApp.description.includes("not for agent work"));
    assert.ok(!/thunar' file manager, 'xterm'/.test(openApp.description), "must not suggest terminal apps as agent strategy");
  });
});
