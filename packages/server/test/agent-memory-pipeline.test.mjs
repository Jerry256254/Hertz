import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import * as schema from "../dist/db/schema.js";
import { runMemoryPipeline } from "../dist/memory/pipeline.js";
import { recallForPrompt, renderMemoryBlock } from "../dist/memory/recall.js";
import { createMemoryTools } from "../dist/tools/memory-tools.js";
import { buildSystemPrompt } from "../dist/agents/system-prompt.js";
import { agentMemoryStatePath } from "../dist/paths.js";

/**
 * End-to-end memory flow against a real SQLite database (no mocks for
 * storage): a fact learned in chat A must surface in chat B and survive a
 * server restart. Also covers the failure path: a failed distillation must
 * not advance the extraction watermark (lost turns were the reported bug).
 */
describe("agent memory pipeline (integration, real SQLite)", () => {
  let dataDir;
  let dbFile;
  let paths;
  let client;
  let db;

  const textBlock = (t) => [{ type: "text", text: t }];

  // Stub provider: fails distillation on demand, otherwise distills one atom.
  let failDistill = false;
  const providers = {
    async getAdapter() {
      return {
        async chat(req) {
          const prompt = req.messages[0].content[0].text;
          if (prompt.includes("Distill durable knowledge")) {
            if (failDistill) throw new Error("provider 404: wrong model name");
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    atoms: [{ text: "Uživatel se jmenuje Jaroslav a vlastní firmu KucLab.", importance: 5 }],
                  }),
                },
              ],
            };
          }
          throw new Error(`unexpected memory prompt: ${prompt.slice(0, 60)}`);
        },
      };
    },
  };

  async function readState() {
    try {
      return JSON.parse(await fs.readFile(agentMemoryStatePath(paths, "proj1", "agent1"), "utf8"));
    } catch {
      return null;
    }
  }

  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-mem-it-"));
    dbFile = path.join(dataDir, "hertz.db");
    paths = { dataDir, projectsDir: path.join(dataDir, "projects") };
    ({ client, db } = openDatabase(dbFile));
    await runMigrations(client);

    const now = new Date();
    await db.insert(schema.users).values({ id: "u1", email: "u@x.y", passwordHash: "x", createdAt: now });
    await db
      .insert(schema.providerConfigs)
      .values({ id: "pc1", userId: "u1", provider: "openai", label: "t", encryptedKey: "{}", createdAt: now });
    await db.insert(schema.projects).values({ id: "proj1", name: "P", createdAt: now });
    await db
      .insert(schema.agents)
      .values({ id: "agent1", projectId: "proj1", name: "Hertz", providerConfigId: "pc1", model: "gpt-test", createdAt: now });
    await db
      .insert(schema.sessions)
      .values({ id: "sessA", agentId: "agent1", projectId: "proj1", title: "chat A", createdAt: now, updatedAt: now });

    let t = Date.now() - 10_000;
    const turns = [
      ["m1", "user", "Ahoj, jmenuju se Jaroslav a vlastním firmu KucLab."],
      ["m2", "assistant", "Těší mě, Jaroslave!"],
      ["m3", "user", "Zapamatuj si to prosím."],
      ["m4", "assistant", "Jasně, pamatuju si to."],
    ];
    for (const [id, role, text] of turns) {
      await db.insert(schema.messages).values({
        id,
        sessionId: "sessA",
        role,
        content: JSON.stringify(textBlock(text)),
        createdAt: new Date((t += 1000)),
      });
    }
  });

  after(async () => {
    try {
      client.close();
    } catch { /* already closed by the restart leg */ }
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("does not advance the watermark when distillation fails (turns are retried)", async () => {
    failDistill = true;
    const didWork = await runMemoryPipeline({ db, paths, providers }, "agent1", "sessA");
    assert.equal(didWork, false);
    assert.equal((await db.select().from(schema.agentMemoryAtoms)).length, 0);

    const state = await readState();
    assert.ok(state, "state file exists (legacy backfill writes it)");
    assert.equal(state.extractedThrough["sessA"], undefined, "watermark must not advance past failed turns");

    // Provider recovers: the same turns are distilled on the next run.
    failDistill = false;
    const didWork2 = await runMemoryPipeline({ db, paths, providers }, "agent1", "sessA");
    assert.equal(didWork2, true);
    const atoms = await db.select().from(schema.agentMemoryAtoms);
    assert.equal(atoms.length, 1);
    assert.match(atoms[0].text, /Jaroslav/);
    assert.equal(atoms[0].agentId, "agent1");
    assert.equal(atoms[0].sourceSessionId, "sessA");

    const state2 = await readState();
    assert.equal(state2.extractedThrough["sessA"], "m4", "watermark advances past distilled turns");
  });

  it("remember() stores an explicit fact on the same agent", async () => {
    const tools = createMemoryTools(db, paths);
    const remember = tools.find((t) => t.name === "remember");
    const res = await remember.execute(
      { note: "Oblíbená barva uživatele je modrá.", kind: "preference" },
      { actor: { actorId: "agent1", actorType: "agent", sessionId: "sessA", projectId: "proj1" } },
    );
    assert.match(res.summary, /Remembered/);
    const atoms = await db.select().from(schema.agentMemoryAtoms).where(eq(schema.agentMemoryAtoms.agentId, "agent1"));
    assert.ok(atoms.some((a) => a.text.includes("modrá")), "remembered fact persisted");
  });

  it("facts from chat A appear in a fresh chat B system prompt", async () => {
    const now = new Date();
    await db
      .insert(schema.sessions)
      .values({ id: "sessB", agentId: "agent1", projectId: "proj1", title: "chat B", createdAt: now, updatedAt: now });
    const agentRow = (await db.select().from(schema.agents))[0];
    const prompt = await buildSystemPrompt(db, agentRow, {
      paths,
      projectId: "proj1",
      sessionId: "sessB",
      conversationContext: "co o mně víš?",
    });
    assert.match(prompt, /Your memory/);
    assert.match(prompt, /Jaroslav a vlastní firmu KucLab/);
    assert.match(prompt, /Oblíbená barva uživatele je modrá/);

    const recall = await recallForPrompt(db, paths, "agent1", "co o mně víš?", "sessB", "proj1");
    const block = renderMemoryBlock(recall);
    assert.match(block, /Jaroslav/);
  });

  it("memory survives a server restart (DB reopen)", async () => {
    client.close();
    const reopened = openDatabase(dbFile);
    client = reopened.client;
    db = reopened.db;

    const atoms = await db.select().from(schema.agentMemoryAtoms);
    assert.equal(atoms.length, 2, "both the distilled atom and the remembered fact survive");

    const agentRow = (await db.select().from(schema.agents))[0];
    const prompt = await buildSystemPrompt(db, agentRow, {
      paths,
      projectId: "proj1",
      sessionId: "sessC",
      conversationContext: "co o mně víš?",
    });
    assert.match(prompt, /Jaroslav a vlastní firmu KucLab/);
    assert.match(prompt, /Oblíbená barva uživatele je modrá/);
  });
});
