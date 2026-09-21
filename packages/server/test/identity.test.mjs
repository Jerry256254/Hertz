import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { agents, providerConfigs, projects, users } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import { defaultAgentPrompt, defaultSoul } from "../dist/agents/persona.js";
import { buildSystemPrompt } from "../dist/agents/system-prompt.js";
import { createIdentityTools } from "../dist/tools/identity-tools.js";
import { createToolPort } from "../dist/tools/tool-port.js";

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/u;

async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-identity-"));
  const { client, db } = openDatabase(path.join(dir, "test.db"));
  await runMigrations(client);
  return { client, db, dir };
}

async function seedAgent(db, fields = {}) {
  const now = new Date();
  await db.insert(users).values({ id: "user-1", email: "u@x.y", passwordHash: "h", role: "admin", createdAt: now });
  await db.insert(projects).values({ id: "proj-1", name: "p", createdAt: now });
  await db
    .insert(providerConfigs)
    .values({ id: "pc-1", userId: "user-1", provider: "openai", label: "l", encryptedKey: "k", createdAt: now });
  await db.insert(agents).values({
    id: "agent-1",
    projectId: "proj-1",
    name: "Karel",
    providerConfigId: "pc-1",
    model: "m",
    systemPrompt: defaultAgentPrompt("Karel"),
    onboardedAt: now,
    createdAt: now,
    ...fields,
  });
}

const actor = { actorId: "agent-1", actorType: "agent", sessionId: "sess-1", projectId: "proj-1" };

async function loadAgent(db) {
  return (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0];
}

describe("identity columns (migration)", () => {
  it("fresh DB has character, vibe, soul and user_profile on agents", async () => {
    const { client, db } = await makeDb();
    const cols = await client.execute("PRAGMA table_info(agents)");
    const names = cols.rows.map((r) => r.name);
    for (const col of ["character", "vibe", "soul", "user_profile"]) {
      assert.ok(names.includes(col), `agents must have column ${col}`);
    }
    client.close();
  });

  it("ALTER TABLE migrations are idempotent on an existing DB", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db, { character: "trpělivý", vibe: "klidný", soul: "duše", userProfile: "profil" });
    // Second run must not fail on duplicate columns.
    await runMigrations(client);
    const agent = await loadAgent(db);
    assert.equal(agent.character, "trpělivý");
    assert.equal(agent.soul, "duše");
    assert.equal(agent.userProfile, "profil");
    client.close();
  });
});

describe("system prompt injects identity, soul and user profile", () => {
  it("stored identity, soul and user profile all land in the prompt", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db, {
      character: "trpělivý průvodce",
      vibe: "klidný a vtipný",
      soul: "Jsem Karel a mám rád dlouhé procházky.",
      userProfile: "Jméno: Jaroslav. Má rád černý humor.",
    });
    const prompt = await buildSystemPrompt(db, await loadAgent(db), {});
    assert.match(prompt, /Karel/, "agent name must be in the prompt");
    assert.match(prompt, /trpělivý průvodce/, "character must be injected");
    assert.match(prompt, /klidný a vtipný/, "vibe must be injected");
    assert.match(prompt, /Jsem Karel a mám rád dlouhé procházky\./, "soul must be injected");
    assert.match(prompt, /Má rád černý humor/, "user profile must be injected");
    assert.match(prompt, /update_soul/, "soul maintenance guidance must be present");
    assert.match(prompt, /update_user_profile/, "user-profile maintenance guidance must be present");
    client.close();
  });

  it("NULL soul falls back to the default soul, empty profile invites completion", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db);
    const prompt = await buildSystemPrompt(db, await loadAgent(db), {});
    assert.ok(prompt.includes(defaultSoul("Karel")), "default soul must be used when agents.soul is NULL");
    assert.match(prompt, /update_user_profile/, "empty profile must point at the update tool");
    assert.match(prompt, /Na jméno se pak už nikdy neptej/, "empty profile must carry the never-re-ask rule");
    client.close();
  });

  it("prompt keeps the Czech rules, nuanced emoji rule and no project framing", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db, { soul: "Testovací duše bez problémů.", userProfile: "Profil bez problémů." });
    const prompt = await buildSystemPrompt(db, await loadAgent(db), {});
    assert.ok(!EMOJI_RE.test(prompt), "full prompt must contain no literal emoji");
    assert.ok(!/projekt/i.test(prompt), "prompt must not contain 'projekt'");
    assert.ok(!/TVRDÝ ZÁKAZ/.test(prompt), "no hard emoji ban allowed");
    assert.match(prompt, /střídmě/i, "nuanced emoji rule must be present");
    assert.match(prompt, /Jak odpovídáš/, "reply rules must be present");
    client.close();
  });
});

describe("identity tools (update_soul / update_user_profile)", () => {
  it("update_soul persists a rewrite", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db);
    const [updateSoul] = createIdentityTools(db);
    assert.equal(updateSoul.name, "update_soul");
    const res = await updateSoul.execute({ soul: "Nová duše Karla." }, { actor });
    assert.ok(!res.isError, res.summary);
    assert.equal((await loadAgent(db)).soul, "Nová duše Karla.");
    client.close();
  });

  it("update_soul appends when asked", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db, { soul: "První část." });
    const [updateSoul] = createIdentityTools(db);
    const res = await updateSoul.execute({ soul: "Druhá část.", mode: "append" }, { actor });
    assert.ok(!res.isError, res.summary);
    assert.equal((await loadAgent(db)).soul, "První část.\n\nDruhá část.");
    client.close();
  });

  it("update_user_profile persists and appends", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db);
    const [, updateUserProfile] = createIdentityTools(db);
    assert.equal(updateUserProfile.name, "update_user_profile");
    const res = await updateUserProfile.execute({ userProfile: "Jméno: Jaroslav." }, { actor });
    assert.ok(!res.isError, res.summary);
    assert.equal((await loadAgent(db)).userProfile, "Jméno: Jaroslav.");
    const res2 = await updateUserProfile.execute({ userProfile: "Má rád kávu.", mode: "append" }, { actor });
    assert.ok(!res2.isError, res2.summary);
    assert.equal((await loadAgent(db)).userProfile, "Jméno: Jaroslav.\n\nMá rád kávu.");
    client.close();
  });

  it("tools reject empty text and unknown agents", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db);
    const [updateSoul] = createIdentityTools(db);
    await assert.rejects(updateSoul.execute({ soul: "" }, { actor }), "empty soul must fail validation");
    const badActor = { ...actor, actorId: "nope" };
    const res = await updateSoul.execute({ soul: "x" }, { actor: badActor });
    assert.ok(res.isError, "unknown agent must fail");
    client.close();
  });

  it("tool port exposes both tools to onboarded agents", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db);
    const port = createToolPort({
      db,
      paths: {},
      sandboxRegistry: {},
      mcpRegistry: { listToolDefinitions: async () => [], isMcpTool: () => false, run: async () => ({}) },
      shellManager: {},
      providers: {},
      queue: {},
      persistence: {},
      masterKey: Buffer.alloc(32),
      desktop: {},
      getAgentLoop: () => ({}),
      getSubagents: () => ({}),
    });
    const names = (await port.listDefinitions("agent-1")).map((d) => d.name);
    assert.ok(names.includes("update_soul"), "tool port must list update_soul");
    assert.ok(names.includes("update_user_profile"), "tool port must list update_user_profile");
    client.close();
  });
});
