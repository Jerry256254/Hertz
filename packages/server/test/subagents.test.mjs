import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { agents, jobs, providerConfigs, projects, sessions, users } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import {
  SubagentManager,
  SUBAGENT_EXCLUDED_TOOLS,
  buildSubagentTaskMessage,
  extractJson,
  isSubagentChildSession,
  validateAgainstSchema,
} from "../dist/agents/subagents.js";
import { createSubagentTools } from "../dist/tools/subagent-tools.js";

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/u;

async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-subagents-"));
  const { client, db } = openDatabase(path.join(dir, "test.db"));
  await runMigrations(client);
  const now = new Date();
  await db.insert(users).values({ id: "user-1", email: "u@x.y", passwordHash: "h", role: "admin", createdAt: now });
  await db.insert(projects).values({ id: "proj-1", name: "p", createdAt: now });
  await db
    .insert(providerConfigs)
    .values({ id: "pc-1", userId: "user-1", provider: "openai", label: "l", encryptedKey: "k", createdAt: now });
  await db.insert(agents).values({
    id: "agent-1",
    projectId: "proj-1",
    name: "Orion",
    providerConfigId: "pc-1",
    model: "m",
    createdAt: now,
  });
  await db.insert(sessions).values({
    id: "parent-1",
    agentId: "agent-1",
    projectId: "proj-1",
    title: "Hlavní chat",
    mode: "autonomous",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return { client, db, dir };
}

function makeFakes() {
  const listeners = new Map();
  const running = new Set();
  const messages = new Map(); // sessionId -> PersistedMessage[]
  const fakes = {
    listeners,
    running,
    appendedInbound: [],
    stopped: [],
    notified: [],
    enqueuedRuns: [],
    appendedMessages: [],
    agentLoop: {
      subscribe: (id, fn) => {
        listeners.set(id, fn);
        return () => listeners.delete(id);
      },
      isRunning: (id) => running.has(id),
      appendInbound: async (id, blocks, sender) => {
        fakes.appendedInbound.push({ id, blocks, sender });
        const arr = messages.get(id) ?? [];
        arr.push({ id: `m-${arr.length}`, sessionId: id, role: "user", content: blocks });
        messages.set(id, arr);
      },
      stop: (id) => {
        fakes.stopped.push(id);
        running.delete(id);
        return true;
      },
      notify: (id, event) => {
        fakes.notified.push({ id, event });
      },
    },
    persistence: {
      appendMessage: async (msg) => {
        const arr = messages.get(msg.sessionId) ?? [];
        const saved = { id: `m-${arr.length}`, ...msg };
        arr.push(saved);
        messages.set(msg.sessionId, arr);
        fakes.appendedMessages.push(saved);
        return saved;
      },
      listMessages: async (sessionId) => messages.get(sessionId) ?? [],
    },
    enqueueAgentRun: async (payload) => {
      fakes.enqueuedRuns.push(payload);
      return `job-${fakes.enqueuedRuns.length}`;
    },
    seedAssistantOutput: (sessionId, text) => {
      const arr = messages.get(sessionId) ?? [];
      arr.push({ id: `m-${arr.length}`, sessionId, role: "assistant", content: [{ type: "text", text }] });
      messages.set(sessionId, arr);
    },
  };
  return fakes;
}

function makeManager(db, fakes, opts = {}) {
  return new SubagentManager({
    db,
    agentLoop: fakes.agentLoop,
    persistence: fakes.persistence,
    queue: {},
    enqueueAgentRun: fakes.enqueueAgentRun,
    fallbackUserId: async () => "user-1",
    maxConcurrent: opts.maxConcurrent,
  });
}

const parent = { parentSessionId: "parent-1", agentId: "agent-1", projectId: "proj-1", userId: "user-1" };
const tick = () => new Promise((r) => setImmediate(r));

describe("subagent lifecycle: spawn → run → result handoff", () => {
  let client, db, fakes, manager;
  beforeEach(async () => {
    ({ client, db } = await makeDb());
    fakes = makeFakes();
    manager = makeManager(db, fakes);
  });

  it("spawns an isolated child session and starts it immediately when capacity allows", async () => {
    const rec = await manager.spawn(parent, { task: "Sečti 2+2", label: "Matika" });
    await tick();
    assert.equal(rec.status, "running");
    assert.equal(fakes.enqueuedRuns.length, 1);
    assert.equal(fakes.enqueuedRuns[0].sessionId, rec.childSessionId);
    assert.ok(fakes.enqueuedRuns[0].excludeTools.includes("spawn_subagent"), "child must not spawn nested subagents");
    assert.ok(fakes.enqueuedRuns[0].excludeTools.includes("ask_user"), "child must not ask the human directly");

    const child = (await db.select().from(sessions).where(eq(sessions.id, rec.childSessionId)).limit(1))[0];
    assert.equal(child.agentId, "agent-1", "child inherits the parent's agent (permissions)");
    assert.equal(child.projectId, "proj-1", "child inherits the parent's project");
    assert.notEqual(child.id, "parent-1", "child has its own isolated session");
    assert.equal(child.parentSessionId, "parent-1", "child is linked to the parent session");
    assert.ok(isSubagentChildSession(child.metadata));
    assert.ok(!isSubagentChildSession(null));
    client.close();
  });

  it("delivers the result to the parent session when the child finishes", async () => {
    const rec = await manager.spawn(parent, { task: "Najdi cenu", label: "Rešerše" });
    await tick();
    fakes.seedAssistantOutput(rec.childSessionId, "Našel jsem cenu 100 Kč.");
    await manager.handleRunFinished(rec.childSessionId);

    assert.equal(manager.get(rec.childSessionId).status, "done");
    // Parent was idle → a new agent run is enqueued so the main agent summarizes the result.
    const handoff = fakes.enqueuedRuns.find((r) => r.sessionId === "parent-1");
    assert.ok(handoff, "parent must get an agent run with the subagent result");
    const text = handoff.userMessage.map((b) => b.text).join("\n");
    assert.match(text, /Rešerše/, "handoff names the subagent");
    assert.match(text, /100 Kč/, "handoff carries the raw result, not a re-interpretation");
    client.close();
  });

  it("hands off via appendInbound when the parent is mid-conversation", async () => {
    fakes.running.add("parent-1");
    const rec = await manager.spawn(parent, { task: "Úkol", label: "L1" });
    await tick();
    fakes.seedAssistantOutput(rec.childSessionId, "hotovo");
    await manager.handleRunFinished(rec.childSessionId);

    assert.equal(fakes.enqueuedRuns.filter((r) => r.sessionId === "parent-1").length, 0);
    const inbound = fakes.appendedInbound.find((a) => a.id === "parent-1");
    assert.ok(inbound, "running parent gets the result as an inbound message");
    assert.match(inbound.blocks.map((b) => b.text).join("\n"), /hotovo/);
    client.close();
  });

  it("marks failed when the child run errored and still notifies the parent", async () => {
    const rec = await manager.spawn(parent, { task: "Úkol", label: "L1" });
    await tick();
    await db.update(sessions).set({ status: "error" }).where(eq(sessions.id, rec.childSessionId));
    await manager.handleRunFinished(rec.childSessionId);
    assert.equal(manager.get(rec.childSessionId).status, "failed");
    assert.ok(fakes.enqueuedRuns.some((r) => r.sessionId === "parent-1"), "parent is told about the failure");
    client.close();
  });

  it("notifies the parent session stream on lifecycle changes", async () => {
    const rec = await manager.spawn(parent, { task: "Úkol", label: "L1" });
    await tick();
    assert.ok(
      fakes.notified.some((n) => n.id === "parent-1" && n.event.type === "subagents"),
      "parent stream gets subagents events for the UI indicator",
    );
    const summaries = manager.summariesForParent("parent-1");
    assert.equal(summaries[0].label, "L1");
    assert.equal(summaries[0].status, "running");
    client.close();
  });

  it("recover() rebuilds state after a restart: pending children are re-queued", async () => {
    // Simulate a crash: pending child persisted in DB, no in-memory record.
    const now = new Date();
    await db.insert(sessions).values({
      id: "child-crash",
      agentId: "agent-1",
      projectId: "proj-1",
      title: "Pád",
      mode: "autonomous",
      status: "active",
      metadata: JSON.stringify({
        subagent: {
          parentSessionId: "parent-1",
          label: "Pád",
          task: "Dokonči po restartu",
          status: "pending",
          correctionUsed: false,
          userId: "user-1",
        },
      }),
      parentSessionId: "parent-1",
      createdAt: now,
      updatedAt: now,
    });

    const freshFakes = makeFakes();
    const fresh = makeManager(db, freshFakes);
    await fresh.recover();
    await tick();
    const rec = fresh.get("child-crash");
    assert.ok(rec, "record rebuilt from DB");
    assert.equal(rec.status, "running", "pending child is started after recovery");
    assert.equal(freshFakes.enqueuedRuns.length, 1);
    assert.equal(freshFakes.enqueuedRuns[0].sessionId, "child-crash");
    client.close();
  });
});

describe("concurrency limit and queue", () => {
  let client, db, fakes, manager;
  beforeEach(async () => {
    ({ client, db } = await makeDb());
    fakes = makeFakes();
    manager = makeManager(db, fakes, { maxConcurrent: 1 });
  });

  it("queues spawns beyond the limit and starts the next one when a slot frees", async () => {
    const a = await manager.spawn(parent, { task: "A", label: "A" });
    const b = await manager.spawn(parent, { task: "B", label: "B" });
    await tick();
    assert.equal(manager.get(a.childSessionId).status, "running");
    assert.equal(manager.get(b.childSessionId).status, "pending", "second subagent waits in the queue");
    assert.equal(fakes.enqueuedRuns.length, 1);

    fakes.seedAssistantOutput(a.childSessionId, "A hotovo");
    await manager.handleRunFinished(a.childSessionId);
    await tick();
    assert.equal(manager.get(b.childSessionId).status, "running", "queue drains after the first finishes");
    assert.equal(fakes.enqueuedRuns.filter((r) => r.sessionId === b.childSessionId).length, 1);
    client.close();
  });

  it("rejects non-positive concurrency settings", () => {
    assert.throws(() => manager.setMaxConcurrent(0), /kladné/);
  });

  it("does not enqueue a duplicate job when the child's run is already queued (restart dedup)", async () => {
    const rec = await manager.spawn(parent, { task: "A", label: "A" });
    await tick();
    // Simulate boot reconciliation: the crashed run's job is back in the queue.
    const now = new Date();
    await db.insert(jobs).values({
      id: "job-dup",
      type: "agent_run",
      payload: JSON.stringify({ sessionId: rec.childSessionId }),
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      runAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const enqueuedBefore = fakes.enqueuedRuns.length;
    // A fresh manager after restart must not enqueue a second job for the child.
    const fresh = makeManager(db, fakes, { maxConcurrent: 1 });
    await fresh.recover();
    await tick();
    assert.equal(
      fakes.enqueuedRuns.length,
      enqueuedBefore,
      "no duplicate agent_run job for a child that is already queued",
    );
    assert.equal(fresh.get(rec.childSessionId).status, "running", "child is tracked as running");
    client.close();
  });
});

describe("stop and follow-up instructions", () => {
  let client, db, fakes, manager;
  beforeEach(async () => {
    ({ client, db } = await makeDb());
    fakes = makeFakes();
    manager = makeManager(db, fakes);
  });

  it("stop_subagent aborts the run, marks interrupted, no handoff", async () => {
    const rec = await manager.spawn(parent, { task: "Úkol", label: "L1" });
    await tick();
    fakes.running.add(rec.childSessionId);
    await manager.stop(rec.childSessionId, "parent-1");
    assert.equal(manager.get(rec.childSessionId).status, "interrupted");
    assert.ok(fakes.stopped.includes(rec.childSessionId), "agent loop stop called");

    // The aborted job still calls back — it must not hand anything to the parent.
    const before = fakes.enqueuedRuns.length;
    await manager.handleRunFinished(rec.childSessionId);
    assert.equal(fakes.enqueuedRuns.length, before, "interrupted subagent delivers no handoff");
    client.close();
  });

  it("send_to_subagent reaches a running child via appendInbound", async () => {
    const rec = await manager.spawn(parent, { task: "Úkol", label: "L1" });
    await tick();
    fakes.running.add(rec.childSessionId);
    await manager.send(rec.childSessionId, "parent-1", "Ještě zkontroluj zdroje.");
    const inbound = fakes.appendedInbound.find((a) => a.id === rec.childSessionId);
    assert.ok(inbound);
    assert.match(inbound.blocks.map((b) => b.text).join("\n"), /zkontroluj zdroje/);
    client.close();
  });

  it("a session cannot manage another session's subagents (isolation)", async () => {
    const rec = await manager.spawn(parent, { task: "Úkol", label: "L1" });
    await tick();
    await assert.rejects(manager.send(rec.childSessionId, "other-session", "x"), /nebyl nalezen/);
    await assert.rejects(manager.stop(rec.childSessionId, "other-session"), /nebyl nalezen/);
    client.close();
  });
});

describe("output_schema contract (Hermes): validation + one correction turn", () => {
  const schema = {
    type: "object",
    required: ["result"],
    properties: { result: { type: "number" } },
    additionalProperties: false,
  };
  let client, db, fakes, manager;
  beforeEach(async () => {
    ({ client, db } = await makeDb());
    fakes = makeFakes();
    manager = makeManager(db, fakes);
  });

  it("accepts a valid JSON output without a correction turn", async () => {
    const rec = await manager.spawn(parent, { task: "Spočítej", label: "L1", outputSchema: schema });
    await tick();
    assert.match(
      fakes.enqueuedRuns[0].userMessage.map((b) => b.text).join("\n"),
      /"result"/,
      "child sees the JSON Schema up front",
    );
    fakes.seedAssistantOutput(rec.childSessionId, '```json\n{"result": 42}\n```');
    await manager.handleRunFinished(rec.childSessionId);
    const done = manager.get(rec.childSessionId);
    assert.equal(done.status, "done");
    assert.equal(done.correctionUsed, false);
    client.close();
  });

  it("invalid output triggers exactly one correction turn, then hands off raw text", async () => {
    const rec = await manager.spawn(parent, { task: "Spočítej", label: "L1", outputSchema: schema });
    await tick();
    fakes.seedAssistantOutput(rec.childSessionId, "Prostě text, žádné JSON.");
    await manager.handleRunFinished(rec.childSessionId);

    let done = manager.get(rec.childSessionId);
    assert.equal(done.correctionUsed, true, "one bounded correction turn used");
    assert.equal(done.status, "running", "not finalized yet");
    const correction = fakes.appendedInbound.find((a) => a.id === rec.childSessionId);
    assert.ok(correction, "child gets the validation errors");
    assert.match(correction.blocks.map((b) => b.text).join("\n"), /neodpovídal/);
    const rerun = fakes.enqueuedRuns.find((r) => r.sessionId === rec.childSessionId && r.prePersisted);
    assert.ok(rerun, "correction run enqueued");

    // Still invalid after the correction → done anyway, raw text preserved (Hermes rule).
    fakes.seedAssistantOutput(rec.childSessionId, "Stále jen text.");
    await manager.handleRunFinished(rec.childSessionId);
    done = manager.get(rec.childSessionId);
    assert.equal(done.status, "done");
    assert.ok(done.schemaFailureNote, "schema failure is noted, work is not discarded");
    assert.equal(fakes.enqueuedRuns.filter((r) => r.sessionId === rec.childSessionId).length, 2, "no second correction turn");
    const handoff = fakes.enqueuedRuns.find((r) => r.sessionId === "parent-1");
    assert.match(handoff.userMessage.map((b) => b.text).join("\n"), /Stále jen text/);
    client.close();
  });

  it("missing required field triggers the correction turn", async () => {
    const rec = await manager.spawn(parent, { task: "Spočítej", label: "L1", outputSchema: schema });
    await tick();
    fakes.seedAssistantOutput(rec.childSessionId, '{"other": 1}');
    await manager.handleRunFinished(rec.childSessionId);
    assert.equal(manager.get(rec.childSessionId).correctionUsed, true);
    const correction = fakes.appendedInbound.find((a) => a.id === rec.childSessionId);
    assert.match(correction.blocks.map((b) => b.text).join("\n"), /result/);
    client.close();
  });
});

describe("JSON-Schema subset validator", () => {
  it("validates types, required, nested objects, arrays, enum", () => {
    const schema = {
      type: "object",
      required: ["name", "tags"],
      properties: {
        name: { type: "string", minLength: 2 },
        age: { type: "integer", minimum: 0 },
        tags: { type: "array", items: { type: "string" } },
        role: { type: "string", enum: ["dev", "ops"] },
      },
      additionalProperties: false,
    };
    assert.deepEqual(validateAgainstSchema(schema, { name: "Al", tags: ["x"], role: "dev" }), []);
    assert.ok(validateAgainstSchema(schema, { tags: [] }).some((e) => e.includes('name')), "missing required");
    assert.ok(validateAgainstSchema(schema, { name: "A", tags: [] }).some((e) => e.includes("minimum") || e.includes("minLength") || e.includes("kratší")), "minLength");
    assert.ok(validateAgainstSchema(schema, { name: "Al", tags: [1] }).length > 0, "array item type");
    assert.ok(validateAgainstSchema(schema, { name: "Al", tags: [], role: "qa" }).length > 0, "enum");
    assert.ok(validateAgainstSchema(schema, { name: "Al", tags: [], extra: 1 }).some((e) => e.includes("nepovolené")), "additionalProperties false");
    assert.ok(validateAgainstSchema(schema, "nope").some((e) => e.includes("object")), "root type");
  });

  it("extractJson handles plain and fenced JSON", () => {
    assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```').value, { a: 1 });
    assert.ok(extractJson("není json").error);
  });
});

describe("task message builder", () => {
  it("tells the child it is a background subagent and shows the schema", () => {
    const msg = buildSubagentTaskMessage({ task: "Udělej X", context: "ctx", outputSchema: { type: "object" } });
    assert.match(msg, /podagent/i);
    assert.match(msg, /Udělej X/);
    assert.match(msg, /ctx/);
    assert.match(msg, /"type": "object"/, "schema visible up front");
    assert.match(msg, /Neptej se uživatele/);
  });
});

describe("security: no escalation", () => {
  it("subagent tool surface excludes nesting and direct user contact", () => {
    assert.ok(SUBAGENT_EXCLUDED_TOOLS.includes("spawn_subagent"));
    assert.ok(SUBAGENT_EXCLUDED_TOOLS.includes("ask_user"));
  });
});

describe("agent tools (Czech, no emoji)", () => {
  let client, db, fakes, manager, tools;
  const byName = () => Object.fromEntries(tools.map((t) => [t.name, t]));
  const ctx = { actor: { actorId: "agent-1", actorType: "agent", sessionId: "parent-1", projectId: "proj-1", userId: "user-1" } };
  beforeEach(async () => {
    ({ client, db } = await makeDb());
    fakes = makeFakes();
    manager = makeManager(db, fakes);
    tools = createSubagentTools(() => manager);
  });

  it("exposes the five delegation tools with Czech descriptions and no emoji", () => {
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["list_subagents", "send_to_subagent", "spawn_subagent", "stop_subagent", "subagent_status"]);
    for (const t of tools) {
      assert.ok(!EMOJI_RE.test(t.description), `${t.name}: no emoji`);
      assert.match(t.description, /podagent/i, `${t.name}: Czech description`);
    }
    client.close();
  });

  it("spawn_subagent → subagent_status → stop_subagent round trip", async () => {
    const t = byName();
    const spawned = await t.spawn_subagent.execute({ task: "Sečti 1+1", label: "Sčítání" }, ctx);
    assert.match(spawned.summary, /Sčítání/);
    const id = manager.listForParent("parent-1")[0].id;

    const status = await t.subagent_status.execute({ subagent_id: id }, ctx);
    assert.match(status.summary, /Sečti 1\+1/);

    const listed = await t.list_subagents.execute({}, ctx);
    assert.match(listed.summary, /Sčítání/);

    const stopped = await t.stop_subagent.execute({ subagent_id: id }, ctx);
    assert.match(stopped.summary, /zastaven/i);
    assert.equal(manager.get(id).status, "interrupted");

    const unknown = await t.subagent_status.execute({ subagent_id: "nope" }, ctx);
    assert.equal(unknown.isError, true);
    client.close();
  });

  it("spawn_subagent rejects an empty task", async () => {
    const t = byName();
    await assert.rejects(t.spawn_subagent.execute({ task: "  " }, ctx), /prázdný/);
    client.close();
  });
});
