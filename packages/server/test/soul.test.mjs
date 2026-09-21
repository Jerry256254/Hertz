import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { agents, providerConfigs, projects, users } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import { defaultSoul, seedSoul } from "../dist/agents/persona.js";
import { ensureAgent } from "../dist/bootstrap.js";
import { buildSystemPrompt } from "../dist/agents/system-prompt.js";
import { createOnboardingTools } from "../dist/tools/onboarding-tools.js";

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/u;

async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-soul-"));
  const { client, db } = openDatabase(path.join(dir, "test.db"));
  await runMigrations(client);
  return { client, db, dir };
}

async function seedInfra(db) {
  const now = new Date();
  await db.insert(users).values({ id: "user-1", email: "u@x.y", passwordHash: "h", role: "admin", createdAt: now });
  await db.insert(projects).values({ id: "proj-1", name: "p", createdAt: now });
  await db
    .insert(providerConfigs)
    .values({ id: "pc-1", userId: "user-1", provider: "openai", label: "l", encryptedKey: "k", createdAt: now });
}

async function insertAgent(db, { id = "agent-1", name = "Karel", soul = null, character = null, vibe = null } = {}) {
  await db.insert(agents).values({
    id,
    projectId: "proj-1",
    name,
    providerConfigId: "pc-1",
    model: "m",
    systemPrompt: "prompt",
    character,
    vibe,
    soul,
    createdAt: new Date(),
  });
}

const actor = { actorId: "agent-1", actorType: "agent", sessionId: "sess-1", projectId: "proj-1" };

describe("soul seeding (SOUL.md od první minuty)", () => {
  it("seedSoul je česky, jmenuje agenta, bez emoji, a zapracuje charakter + vibe", () => {
    const soul = seedSoul("Karel", "zkušený průvodce", "klidný a vtipný");
    assert.match(soul, /Karel/, "duše musí jmenovat agenta");
    assert.match(soul, /česky/, "duše musí být česky");
    assert.match(soul, /zkušený průvodce/, "charakter se musí promítnout do duše");
    assert.match(soul, /klidný a vtipný/, "vibe se musí promítnout do duše");
    assert.ok(!EMOJI_RE.test(soul), "duše nesmí obsahovat emoji");
    assert.match(soul, /KÝM JSEM/, "duše má strukturu identity");
    assert.match(soul, /update_soul/, "duše musí agenta učit, jak se vyvíjí");
  });

  it("defaultSoul zůstává česky a jmenuje agenta (záloha pro system prompt)", () => {
    const soul = defaultSoul("Karel");
    assert.match(soul, /Karel/);
    assert.match(soul, /česky/);
    assert.ok(!EMOJI_RE.test(soul));
  });

  it("ensureAgent ukládá duši do DB hned při vytvoření agenta", async () => {
    const { client, db } = await makeDb();
    await seedInfra(db);
    const id = await ensureAgent({ db }, { projectId: "proj-1", providerConfigId: "pc-1", model: "m", name: "Karel" });
    const agent = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
    assert.ok(agent.soul && agent.soul.trim(), "nový agent musí mít duši v DB");
    assert.match(agent.soul, /Karel/, "duše musí jmenovat agenta");
    assert.match(agent.soul, /česky/);
    assert.ok(!EMOJI_RE.test(agent.soul), "duše nesmí obsahovat emoji");
    client.close();
  });

  it("migrace při startu serveru dogeneruje duši agentům bez duše a stávající duše nechá", async () => {
    const { client, db } = await makeDb();
    await seedInfra(db);
    // Starší agent bez duše (včetně prázdného stringu) + agent s vlastní duší.
    await insertAgent(db, { id: "agent-1", name: "Karel", soul: null });
    await insertAgent(db, { id: "agent-2", name: "Jana", soul: "   " });
    await insertAgent(db, { id: "agent-3", name: "Petr", soul: "Moje vlastní duše." });
    await runMigrations(client); // druhý běh = simulace restartu serveru
    const rows = await db.select().from(agents);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.match(byId["agent-1"].soul ?? "", /Karel/, "agent bez duše dostane duši se svým jménem");
    assert.ok(!EMOJI_RE.test(byId["agent-1"].soul ?? ""));
    assert.match(byId["agent-2"].soul ?? "", /Jana/, "prázdná duše se doseeduje");
    assert.equal(byId["agent-3"].soul, "Moje vlastní duše.", "vlastní duše se nikdy nepřepisuje");
    client.close();
  });

  it("migrace zapracuje charakter a vibe existujícího agenta do dogenerované duše", async () => {
    const { client, db } = await makeDb();
    await seedInfra(db);
    await insertAgent(db, { id: "agent-1", name: "Karel", soul: null, character: "noční sova", vibe: "hravý" });
    await runMigrations(client);
    const agent = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0];
    assert.match(agent.soul ?? "", /noční sova/, "charakter se promítne");
    assert.match(agent.soul ?? "", /hravý/, "vibe se promítne");
    client.close();
  });

  it("complete_onboarding doseeduje duši, když chybí, a existující nechá", async () => {
    const { client, db } = await makeDb();
    await seedInfra(db);
    await insertAgent(db, { id: "agent-1", name: "Orion", soul: null, onboardedAt: null });
    const [tool] = createOnboardingTools(db);
    const res = await tool.execute({ agentName: "Karel", userName: "Jaroslav" }, { actor });
    assert.ok(!res.isError, `tool failed: ${res.summary}`);
    let agent = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0];
    assert.ok(agent.soul && agent.soul.trim(), "po onboardingu musí mít agent duši");
    assert.match(agent.soul, /Karel/, "duše nese nové jméno z onboardingu");

    // Agent, který už duši má (napsal ji sám nebo uživatel), si ji ponechá.
    await db.update(agents).set({ soul: "Moje vlastní duše.", onboardedAt: null }).where(eq(agents.id, "agent-1"));
    const [tool2] = createOnboardingTools(db);
    const again = await tool2.execute({ agentName: "Karel", userName: "Jaroslav" }, { actor });
    assert.ok(!again.isError);
    agent = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0];
    assert.equal(agent.soul, "Moje vlastní duše.", "onboarding nesmí přepsat existující duši");
    client.close();
  });

  it("buildSystemPrompt injektuje uloženou duši agenta", async () => {
    const { client, db } = await makeDb();
    await seedInfra(db);
    await insertAgent(db, { id: "agent-1", name: "Karel", soul: "TESTOVACÍ DUŠE KARLA XYZ" });
    const agent = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0];
    const prompt = await buildSystemPrompt(db, agent, {});
    assert.match(prompt, /TESTOVACÍ DUŠE KARLA XYZ/, "uložená duše musí být v system promptu");
    assert.ok(!EMOJI_RE.test(prompt), "system prompt nesmí obsahovat emoji");

    // Bez uložené duše se použije výchozí — agent nikdy neběží bez duše.
    await db.update(agents).set({ soul: null }).where(eq(agents.id, "agent-1"));
    const soulless = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0];
    const fallback = await buildSystemPrompt(db, soulless, {});
    assert.match(fallback, /Karel/, "záložní duše musí jmenovat agenta");
    assert.match(fallback, /Tvoje duše \(SOUL\.md\)/, "identitní blok musí být přítomen");
    client.close();
  });

  it("seedovaná duše není prázdný stav — nikdy nevznikne agent bez duše", async () => {
    // Nový agent prochází ensureAgent (seed) i migrací (backfill) — obě cesty
    // garantují neprázdnou duši, takže UI nemusí znát žádný prázdný stav.
    const { client, db } = await makeDb();
    await seedInfra(db);
    const id = await ensureAgent({ db }, { projectId: "proj-1", providerConfigId: "pc-1", model: "m", name: "Karel" });
    await runMigrations(client);
    const agent = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
    assert.ok((agent.soul ?? "").trim().length > 100, "duše musí být skutečný text, ne prázdnota");
    client.close();
  });
});
