import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { agents, mounts, projectMembers, projectRoots, projects, providerConfigs, users } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import { registerMountRoutes } from "../dist/routes/mounts.js";
import { MOUNT_NAME_REGEX, RESERVED_MOUNT_NAMES, mountsFor, mountRoots, mountPaths, renderFoldersBlock, validateMountName } from "../dist/mounts/mounts.js";
import { buildSystemPrompt } from "../dist/agents/system-prompt.js";
import { ComputerManager, mountSetsEqual, normalizeBindPath } from "../dist/computer/computer-manager.js";
import { readFileTool, writeFileTool, editFileTool, globTool, grepTool } from "../../tools/dist/index.js";

async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-mounts-"));
  const { client, db } = openDatabase(path.join(dir, "test.db"));
  await runMigrations(client);
  return { client, db, dir };
}

async function seedBase(db, dir) {
  const now = new Date();
  const projRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-mounts-root-"));
  await db.insert(users).values([
    { id: "admin-1", email: "a@x.y", passwordHash: "h", role: "admin", createdAt: now },
    { id: "member-1", email: "m@x.y", passwordHash: "h", role: "user", createdAt: now },
    { id: "outsider-1", email: "o@x.y", passwordHash: "h", role: "user", createdAt: now },
  ]);
  await db.insert(projects).values([
    { id: "proj-1", name: "p1", createdAt: now },
    { id: "proj-2", name: "p2", createdAt: now },
  ]);
  await db.insert(projectRoots).values({ id: "root-1", projectId: "proj-1", rootId: "main", label: "p1", absolutePath: projRoot });
  await db.insert(projectMembers).values({ id: "pm-1", projectId: "proj-1", userId: "member-1", createdAt: now });
  await db.insert(providerConfigs).values({ id: "pc-1", userId: "admin-1", provider: "openai", label: "l", encryptedKey: "k", createdAt: now });
  await db.insert(agents).values([
    { id: "agent-1", projectId: "proj-1", name: "Orion", providerConfigId: "pc-1", model: "m", createdAt: now },
    { id: "agent-2", projectId: "proj-1", name: "Vega", providerConfigId: "pc-1", model: "m", createdAt: now },
    { id: "agent-x", projectId: "proj-2", name: "Other", providerConfigId: "pc-1", model: "m", createdAt: now },
  ]);
  return { projRoot };
}

const asUser = (id, role) => ({ id, email: `${id}@x.y`, role });

async function makeApp(db, user, auditEvents) {
  const app = Fastify();
  app.decorateRequest("user", undefined);
  app.addHook("preHandler", async (req) => {
    req.user = user;
  });
  registerMountRoutes(app, { db, audit: { record: async (e) => void auditEvents.push(e) } });
  await app.ready();
  return app;
}

describe("mounts data model (B1)", () => {
  it("bootstrap creates the mounts table + indexes", async () => {
    const { client } = await makeDb();
    const cols = await client.execute("PRAGMA table_info(mounts)");
    const names = cols.rows.map((r) => r.name);
    for (const c of ["id", "project_id", "agent_id", "name", "host_path", "purpose", "created_by_user_id", "created_at"]) {
      assert.ok(names.includes(c), `${c} column missing`);
    }
    const idx = await client.execute("PRAGMA index_list(mounts)");
    const idxNames = idx.rows.map((r) => r.name);
    assert.ok(idxNames.includes("idx_mounts_project"), "idx_mounts_project missing");
    assert.ok(idxNames.includes("idx_mounts_project_name"), "unique (project,name) index missing");
    client.close();
  });

  it("names validate: regex + reserved words", () => {
    assert.ok(MOUNT_NAME_REGEX.test("photos"));
    assert.ok(MOUNT_NAME_REGEX.test("my-data_2"));
    assert.ok(!MOUNT_NAME_REGEX.test("x"), "single char too short");
    assert.ok(!MOUNT_NAME_REGEX.test("Photos"), "uppercase rejected");
    assert.ok(!MOUNT_NAME_REGEX.test("-data"), "leading dash rejected");
    assert.ok(!MOUNT_NAME_REGEX.test("has space"));
    assert.ok(!MOUNT_NAME_REGEX.test("a".repeat(33)), "33 chars too long");
    assert.equal(validateMountName("photos"), null);
    for (const reserved of ["main", "self", "host", "tmp"]) {
      assert.ok(RESERVED_MOUNT_NAMES.has(reserved));
      assert.match(validateMountName(reserved), /reserved/);
    }
    assert.ok(validateMountName("Bad Name"));
  });

  it("mountsFor returns project-wide + own-agent mounts, ordered by name", async () => {
    const { client, db } = await makeDb();
    await seedBase(db);
    const now = new Date();
    await db.insert(mounts).values([
      { id: "m-wide", projectId: "proj-1", agentId: null, name: "zebra", hostPath: "/tmp/z", purpose: null, createdAt: now },
      { id: "m-own", projectId: "proj-1", agentId: "agent-1", name: "alpha", hostPath: "/tmp/a", purpose: "A", createdAt: now },
      { id: "m-other", projectId: "proj-1", agentId: "agent-2", name: "other", hostPath: "/tmp/o", purpose: null, createdAt: now },
      { id: "m-foreign", projectId: "proj-2", agentId: null, name: "wide2", hostPath: "/tmp/w", purpose: null, createdAt: now },
    ]);
    const rows = await mountsFor(db, "proj-1", "agent-1");
    assert.deepEqual(rows.map((r) => r.name), ["alpha", "zebra"]);
    assert.deepEqual(mountRoots(rows), { alpha: "/tmp/a", zebra: "/tmp/z" });
    assert.deepEqual(mountPaths(rows), ["/tmp/a", "/tmp/z"]);
    const other = await mountsFor(db, "proj-1", "agent-2");
    assert.deepEqual(other.map((r) => r.name), ["other", "zebra"]);
    client.close();
  });
});

describe("mounts API (B2)", () => {
  let db;
  let client;
  let projRoot;
  let hostDir;
  let auditEvents;
  let adminApp;
  let memberApp;
  let outsiderApp;
  let anonApp;

  before(async () => {
    ({ client, db } = await makeDb());
    ({ projRoot } = await seedBase(db));
    hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-mount-host-"));
    auditEvents = [];
    adminApp = await makeApp(db, asUser("admin-1", "admin"), auditEvents);
    memberApp = await makeApp(db, asUser("member-1", "user"), auditEvents);
    outsiderApp = await makeApp(db, asUser("outsider-1", "user"), auditEvents);
    anonApp = await makeApp(db, undefined, auditEvents);
  });

  it("admin creates a mount (201) and it is realpath'd + audited", async () => {
    const res = await adminApp.inject({ method: "POST", url: "/api/projects/proj-1/mounts", payload: { name: "photos", hostPath: hostDir, purpose: "Family photos" } });
    assert.equal(res.statusCode, 201);
    const { id } = res.json();
    assert.ok(id);
    const rows = await db.select().from(mounts).where(eq(mounts.id, id));
    assert.equal(rows[0].hostPath, await fs.realpath(hostDir));
    assert.equal(rows[0].purpose, "Family photos");
    assert.equal(rows[0].createdByUserId, "admin-1");
    const evt = auditEvents.find((e) => e.action === "mount.create");
    assert.ok(evt && evt.actorId === "admin-1" && evt.result === "allowed");
  });

  it("rejects bad names, reserved names, duplicates, bad paths, foreign agentId", async () => {
    const bad = [
      [{ name: "Bad Name", hostPath: hostDir }, 400],
      [{ name: "main", hostPath: hostDir }, 400],
      [{ name: "self", hostPath: hostDir }, 400],
      [{ name: "photos", hostPath: hostDir }, 409],
      [{ name: "rel", hostPath: "relative/path" }, 400],
      [{ name: "ghost", hostPath: path.join(hostDir, "nope") }, 400],
      [{ name: "scoped", hostPath: hostDir, agentId: "agent-x" }, 400],
    ];
    for (const [payload, code] of bad) {
      const res = await adminApp.inject({ method: "POST", url: "/api/projects/proj-1/mounts", payload });
      assert.equal(res.statusCode, code, `${JSON.stringify(payload)} → ${res.statusCode}: ${res.body}`);
    }
    const file = path.join(hostDir, "f.txt");
    await fs.writeFile(file, "x");
    const notDir = await adminApp.inject({ method: "POST", url: "/api/projects/proj-1/mounts", payload: { name: "fileish", hostPath: file } });
    assert.equal(notDir.statusCode, 400);
  });

  it("members see the list (+ built-in main), outsiders and anon do not", async () => {
    for (const [app, code] of [[adminApp, 200], [memberApp, 200]]) {
      const res = await app.inject({ method: "GET", url: "/api/projects/proj-1/mounts" });
      assert.equal(res.statusCode, code);
      const body = res.json();
      assert.ok(body.mounts.some((m) => m.name === "photos"));
      assert.deepEqual(body.builtIn, { name: "main", hostPath: projRoot, purpose: "Project files" });
    }
    const denied = await outsiderApp.inject({ method: "GET", url: "/api/projects/proj-1/mounts" });
    assert.equal(denied.statusCode, 403);
    const anon = await anonApp.inject({ method: "GET", url: "/api/projects/proj-1/mounts" });
    assert.equal(anon.statusCode, 401);
  });

  it("members cannot mutate (admin-only), admin PATCH/DELETE work, hostPath immutable", async () => {
    const forbidden = await memberApp.inject({ method: "POST", url: "/api/projects/proj-1/mounts", payload: { name: "member-mount", hostPath: hostDir } });
    assert.equal(forbidden.statusCode, 403);

    const created = await adminApp.inject({ method: "POST", url: "/api/projects/proj-1/mounts", payload: { name: "docs", hostPath: hostDir } });
    const id = created.json().id;

    const immut = await adminApp.inject({ method: "PATCH", url: `/api/mounts/${id}`, payload: { hostPath: "/elsewhere" } });
    assert.equal(immut.statusCode, 400);
    const dup = await adminApp.inject({ method: "PATCH", url: `/api/mounts/${id}`, payload: { name: "photos" } });
    assert.equal(dup.statusCode, 409);
    const reserved = await adminApp.inject({ method: "PATCH", url: `/api/mounts/${id}`, payload: { name: "tmp" } });
    assert.equal(reserved.statusCode, 400);
    const empty = await adminApp.inject({ method: "PATCH", url: `/api/mounts/${id}`, payload: {} });
    assert.equal(empty.statusCode, 400);

    const renamed = await adminApp.inject({ method: "PATCH", url: `/api/mounts/${id}`, payload: { name: "manuals", purpose: "User manuals" } });
    assert.equal(renamed.statusCode, 200);
    const after = await db.select().from(mounts).where(eq(mounts.id, id));
    assert.equal(after[0].name, "manuals");
    assert.equal(after[0].purpose, "User manuals");
    assert.ok(auditEvents.some((e) => e.action === "mount.update"));

    const memberPatch = await memberApp.inject({ method: "PATCH", url: `/api/mounts/${id}`, payload: { purpose: "hijack" } });
    assert.equal(memberPatch.statusCode, 403);
    const memberDel = await memberApp.inject({ method: "DELETE", url: `/api/mounts/${id}` });
    assert.equal(memberDel.statusCode, 403);

    const del = await adminApp.inject({ method: "DELETE", url: `/api/mounts/${id}` });
    assert.equal(del.statusCode, 204);
    assert.equal((await db.select().from(mounts).where(eq(mounts.id, id))).length, 0);
    assert.ok(auditEvents.some((e) => e.action === "mount.delete"));
    const gone = await adminApp.inject({ method: "DELETE", url: `/api/mounts/${id}` });
    assert.equal(gone.statusCode, 404);
  });
});

describe("folders prompt block (B3)", () => {
  it("buildSystemPrompt threads mounts into a Your-folders block", async () => {
    const prompt = await buildSystemPrompt(undefined, { id: "a", systemPrompt: "base" }, {
      mounts: [
        { name: "photos", purpose: "Family photos" },
        { name: "misc", purpose: null },
      ],
    });
    assert.ok(prompt.includes("## Your folders"));
    assert.ok(prompt.includes("- photos — Family photos (root 'photos')"));
    assert.ok(prompt.includes("- misc — (no description) (root 'misc')"));
    assert.ok(prompt.includes("- main — the shared project folder (root 'main'"));
    assert.ok(prompt.includes("- self — your own personal folder"));
  });

  it("renders built-ins only when there are no mounts", () => {
    const block = renderFoldersBlock([]);
    assert.ok(block.includes("## Your folders") && block.includes("root 'main'") && block.includes("root 'self'"));
  });

  it("all five fs tools describe root as a folder name from Your folders", () => {
    for (const tool of [readFileTool, writeFileTool, editFileTool, globTool, grepTool]) {
      const desc = tool.inputSchema.shape.root.description;
      assert.ok(desc.includes("Your folders"), `${tool.name} root description missing folder hint: ${desc}`);
    }
  });
});

describe("syncMounts container reconciliation (B3)", () => {
  class FakeComputer extends ComputerManager {
    constructor({ state = "running", binds = [], portOk = true } = {}) {
      super({ record: async (e) => void (this.auditEvents ??= []).push(e) });
      this.state = state;
      this.binds = binds;
      this.portOk = portOk;
      this.removed = 0;
      this.startedContainers = 0;
      this.runs = 0;
    }
    async status() {
      return this.state;
    }
    async run(argv) {
      const rest = argv.slice(1);
      if (rest[0] === "inspect" && rest.includes("{{json .HostConfig.Binds}}")) {
        return { exitCode: 0, stdout: JSON.stringify(this.binds.map((b) => `${b}:${b}`)), stderr: "" };
      }
      if (rest[0] === "port") {
        return this.portOk ? { exitCode: 0, stdout: "127.0.0.1:49153\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "no port" };
      }
      if (rest[0] === "rm") {
        this.removed++;
        this.state = "missing";
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (rest[0] === "run") {
        this.runs++;
        this.state = "running";
        return { exitCode: 0, stdout: "cid\n", stderr: "" };
      }
      if (rest[0] === "start") {
        this.startedContainers++;
        this.state = "running";
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  }

  it("normalizeBindPath + mountSetsEqual ignore order, trailing slashes, dot segments", () => {
    assert.equal(normalizeBindPath("/data/"), "/data");
    assert.equal(normalizeBindPath("/x/../data//"), "/data");
    assert.ok(mountSetsEqual(["/a", "/b"], ["/b/", "/a"]));
    assert.ok(!mountSetsEqual(["/a", "/b"], ["/a"]));
    assert.ok(!mountSetsEqual(["/a"], ["/a", "/b"]));
    assert.ok(!mountSetsEqual(["/a"], ["/other"]));
  });

  it("matching binds reuse the running container (no recreate, no audit)", async () => {
    const fake = new FakeComputer({ state: "running", binds: ["/data", "/home/u"] });
    const r = await fake.syncMounts({ agentId: "a1", mountPaths: ["/home/u/", "/data"] });
    assert.deepEqual(r, { containerName: "hertz-agent-a1", created: false, recreated: false });
    assert.equal(fake.removed, 0);
    assert.equal(fake.runs, 0);
    assert.equal(fake.auditEvents?.length ?? 0, 0);
  });

  it("added or removed mounts recreate the container with an audit record", async () => {
    const added = new FakeComputer({ state: "running", binds: ["/data"] });
    const r1 = await added.syncMounts({ agentId: "a1", mountPaths: ["/data", "/extra"] });
    assert.equal(r1.recreated, true);
    assert.equal(added.removed, 1);
    assert.equal(added.runs, 1);
    assert.ok(added.auditEvents.some((e) => e.action === "computer.mounts_resync"));

    const removed = new FakeComputer({ state: "running", binds: ["/data", "/extra"] });
    const r2 = await removed.syncMounts({ agentId: "a1", mountPaths: ["/data"] });
    assert.equal(r2.recreated, true);
    assert.equal(removed.removed, 1);
  });

  it("missing containers are created; stopped ones restart or recreate", async () => {
    const missing = new FakeComputer({ state: "missing" });
    const r1 = await missing.syncMounts({ agentId: "a1", mountPaths: ["/data"] });
    assert.deepEqual([r1.created, r1.recreated], [true, false]);

    const stopped = new FakeComputer({ state: "stopped", binds: ["/data"] });
    const r2 = await stopped.syncMounts({ agentId: "a1", mountPaths: ["/data"] });
    assert.deepEqual([r2.created, r2.recreated], [false, false]);
    assert.equal(stopped.startedContainers, 1);

    const stale = new FakeComputer({ state: "stopped", binds: ["/old"] });
    const r3 = await stale.syncMounts({ agentId: "a1", mountPaths: ["/data"] });
    assert.equal(r3.recreated, true);

    const noPort = new FakeComputer({ state: "stopped", binds: ["/data"], portOk: false });
    const r4 = await noPort.syncMounts({ agentId: "a1", mountPaths: ["/data"] });
    assert.equal(r4.recreated, true);
  });

  it("ensureContainer delegates to syncMounts; unavailable docker throws", async () => {
    const fake = new FakeComputer({ state: "running", binds: ["/data"] });
    const kept = await fake.ensureContainer({ agentId: "a1", mountPaths: ["/data"] });
    assert.deepEqual(kept, { containerName: "hertz-agent-a1", created: false });
    const remade = await fake.ensureContainer({ agentId: "a1", mountPaths: ["/data", "/new"] });
    assert.equal(remade.created, true);

    const down = new FakeComputer({ state: "unavailable" });
    await assert.rejects(() => down.syncMounts({ agentId: "a1", mountPaths: [] }), /Docker isn't available/);
  });
});
