import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { agentMemoryAtoms, agents, providerConfigs, projects, users } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import { defaultAgentPrompt, onboardingPromptBlock } from "../dist/agents/persona.js";
import { buildSystemPrompt } from "../dist/agents/system-prompt.js";
import {
  generateAvatarSpec,
  parseAvatarSpec,
  renderAvatarSvg,
  avatarDataUrl,
  avatarSvgForAgent,
} from "../dist/agents/avatar.js";
import { createOnboardingTools } from "../dist/tools/onboarding-tools.js";
import { createToolPort } from "../dist/tools/tool-port.js";

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/u;

async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-onboarding-"));
  const { client, db } = openDatabase(path.join(dir, "test.db"));
  await runMigrations(client);
  return { client, db, dir };
}

async function seedAgent(db, { name = "Orion", onboardedAt = null, systemPrompt = null } = {}) {
  const now = new Date();
  await db.insert(users).values({ id: "user-1", email: "u@x.y", passwordHash: "h", role: "admin", createdAt: now });
  await db.insert(projects).values({ id: "proj-1", name: "p", createdAt: now });
  await db
    .insert(providerConfigs)
    .values({ id: "pc-1", userId: "user-1", provider: "openai", label: "l", encryptedKey: "k", createdAt: now });
  await db.insert(agents).values({
    id: "agent-1",
    projectId: "proj-1",
    name,
    providerConfigId: "pc-1",
    model: "m",
    systemPrompt: systemPrompt ?? defaultAgentPrompt(name),
    onboardedAt,
    createdAt: now,
  });
}

const actor = { actorId: "agent-1", actorType: "agent", sessionId: "sess-1", projectId: "proj-1" };

describe("persona (Czech-first, no emoji, no corporate greeting)", () => {
  it("defaultAgentPrompt is Czech, names the agent, bans emoji and capability-list greetings", () => {
    const p = defaultAgentPrompt("Karel");
    assert.ok(p.includes("Karel"), "must address the agent by name");
    assert.match(p, /česky/, "must instruct Czech output");
    assert.ok(!EMOJI_RE.test(p), "persona must contain no emoji");
    assert.match(p, /Nikdy nepoužíváš emoji/, "explicit no-emoji rule");
    assert.match(p, /výčtem svých schopností/, "must ban capability-list greetings");
    assert.match(p, /1–3 cally/, "must state the 1-3 calls efficiency rule");
    assert.match(p, /nikdy ne 26/, "must name the 26-calls anti-pattern");
  });

  it("onboardingPromptBlock asks for both names in Czech without emoji", () => {
    const b = onboardingPromptBlock("Orion");
    assert.ok(!EMOJI_RE.test(b), "onboarding block must contain no emoji");
    assert.match(b, /complete_onboarding/, "must point at the onboarding tool");
    assert.match(b, /TY/, "must ask for the agent's name");
    assert.match(b, /ON/, "must ask for the user's name");
  });

  it("buildSystemPrompt injects onboarding for fresh agents and skips it after onboarding", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db, { onboardedAt: null });
    const fresh = (
      await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1)
    )[0];
    const promptFresh = await buildSystemPrompt(db, fresh, {});
    assert.ok(!EMOJI_RE.test(promptFresh), "full system prompt must contain no emoji");
    assert.match(promptFresh, /Onboarding — první spuštění/, "fresh agent must get the onboarding block");
    assert.match(promptFresh, /Jak odpovídáš/, "reply rules must be present");
    assert.match(promptFresh, /Jak pracuješ s nástroji/, "efficiency rules must be present");
    assert.match(promptFresh, /1–3 cally/, "efficiency anti-pattern must be present");

    await db.update(agents).set({ onboardedAt: new Date() }).where(eq(agents.id, "agent-1"));
    const done = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0];
    const promptDone = await buildSystemPrompt(db, done, {});
    assert.ok(!promptDone.includes("Onboarding — první spuštění"), "onboarded agent must not get the onboarding block");
    assert.ok(!EMOJI_RE.test(promptDone), "still no emoji after onboarding");
    client.close();
  });
});

describe("onboarding flow", () => {
  it("new agent -> complete_onboarding stores names, avatar, user profile and onboarding flag", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db, { onboardedAt: null });
    const [tool] = createOnboardingTools(db);
    assert.equal(tool.name, "complete_onboarding");

    const res = await tool.execute({ agentName: "Karel", userName: "Jaroslav" }, { actor });
    assert.ok(!res.isError, `tool failed: ${res.summary}`);
    assert.match(res.summary, /Karel/);

    const agent = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0];
    assert.equal(agent.name, "Karel");
    assert.ok(agent.onboardedAt, "onboardedAt must be set");
    assert.match(agent.systemPrompt, /Karel/);
    assert.ok(!EMOJI_RE.test(agent.systemPrompt), "stored prompt must have no emoji");
    const spec = parseAvatarSpec(agent.avatar);
    assert.ok(spec, "avatar spec must be valid JSON");
    assert.equal(spec.version, 1);

    // The user's name belongs to the permanent user profile (USER.md), not to
    // memory atoms — memory is events, the profile is durable.
    assert.match(agent.userProfile ?? "", /Jaroslav/, "userProfile must carry the user's name");
    const atoms = await db.select().from(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, "agent-1"));
    assert.equal(atoms.length, 0, "onboarding must not write name atoms into memory");
    client.close();
  });

  it("complete_onboarding is idempotent and refuses empty names", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db, { onboardedAt: null });
    const [tool] = createOnboardingTools(db);
    await tool.execute({ agentName: "Karel", userName: "Jaroslav" }, { actor });

    const again = await tool.execute({ agentName: "Jinak", userName: "Jinak" }, { actor });
    assert.ok(!again.isError);
    assert.match(again.summary, /už proběhl/);
    const agent = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0];
    assert.equal(agent.name, "Karel", "second call must not rename");

    const { client: c2, db: db2 } = await makeDb();
    await seedAgent(db2, { onboardedAt: null });
    const [tool2] = createOnboardingTools(db2);
    const bad = await tool2.execute({ agentName: "  ", userName: "Jaroslav" }, { actor });
    assert.ok(bad.isError, "empty agent name must fail");
    client.close();
    c2.close();
  });

  it("regenerate_avatar mints a fresh unique spec", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db, { onboardedAt: new Date() });
    const [, regen] = createOnboardingTools(db);
    assert.equal(regen.name, "regenerate_avatar");
    const before = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0].avatar;
    const res = await regen.execute({}, { actor });
    assert.ok(!res.isError);
    const after = (await db.select().from(agents).where(eq(agents.id, "agent-1")).limit(1))[0].avatar;
    assert.ok(parseAvatarSpec(after), "new spec must be valid");
    assert.notEqual(before, after, "regeneration must change the seed");
    client.close();
  });

  it("tool port hides complete_onboarding once onboarded, keeps regenerate_avatar", async () => {
    const { client, db } = await makeDb();
    await seedAgent(db, { onboardedAt: null });
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
    const beforeNames = (await port.listDefinitions("agent-1")).map((d) => d.name);
    assert.ok(beforeNames.includes("complete_onboarding"), "fresh agent must see complete_onboarding");
    assert.ok(beforeNames.includes("regenerate_avatar"));

    await db.update(agents).set({ onboardedAt: new Date() }).where(eq(agents.id, "agent-1"));
    const afterNames = (await port.listDefinitions("agent-1")).map((d) => d.name);
    assert.ok(!afterNames.includes("complete_onboarding"), "onboarded agent must not see complete_onboarding");
    assert.ok(afterNames.includes("regenerate_avatar"), "regenerate_avatar stays available");
    client.close();
  });
});

describe("generative avatars", () => {
  it("minted specs are unique and carry the agent name", () => {
    const a = generateAvatarSpec("Karel");
    const b = generateAvatarSpec("Karel");
    assert.equal(a.version, 1);
    assert.equal(a.kind, "generative");
    assert.notEqual(a.seed, b.seed, "every mint must be unique");
    assert.match(a.seed, /^karel:/);
  });

  it("rendering is deterministic per seed and varies across seeds", () => {
    const spec = generateAvatarSpec("Karel");
    assert.equal(renderAvatarSvg(spec), renderAvatarSvg(spec), "same seed must render identically");
    assert.equal(renderAvatarSvg(spec.seed), renderAvatarSvg(spec), "string seed must work too");
    const svgs = new Set(Array.from({ length: 12 }, (_, i) => renderAvatarSvg(`test-seed-${i}`)));
    assert.equal(svgs.size, 12, "12 seeds must yield 12 distinct artworks");
  });

  it("artwork is abstract SVG: no text, no letters-in-circles, no emoji", () => {
    const svg = renderAvatarSvg(generateAvatarSpec("Karel"));
    assert.match(svg, /^<svg[^>]*>/);
    assert.match(svg, /<\/svg>$/);
    assert.ok(!svg.includes("<text"), "no text elements (no letter-in-circle slop)");
    assert.ok(!EMOJI_RE.test(svg), "no emoji in artwork");
    assert.ok(svg.length > 2000, "artwork should be non-trivial");
  });

  it("parseAvatarSpec round-trips and rejects garbage", () => {
    const spec = generateAvatarSpec("Karel");
    assert.deepEqual(parseAvatarSpec(JSON.stringify(spec)), spec);
    assert.equal(parseAvatarSpec(null), null);
    assert.equal(parseAvatarSpec(""), null);
    assert.equal(parseAvatarSpec("not json"), null);
    assert.equal(parseAvatarSpec(JSON.stringify({ version: 1, kind: "nope", seed: "x" })), null);
  });

  it("data URL and agent fallback render", () => {
    const url = avatarDataUrl(generateAvatarSpec("Karel"));
    assert.ok(url.startsWith("data:image/svg+xml;base64,"));
    const svg = Buffer.from(url.split(",")[1], "base64").toString("utf8");
    assert.match(svg, /^<svg/);
    const fallback = avatarSvgForAgent(null, "agent-1");
    assert.equal(fallback, avatarSvgForAgent("garbage", "agent-1"), "fallback must be deterministic");
    assert.match(fallback, /^<svg/);
  });
});

describe("onboarding migration", () => {
  it("fresh DBs gain avatar + onboarded_at columns", async () => {
    const { client } = await makeDb();
    for (const table of ["agents"]) {
      const cols = await client.execute(`PRAGMA table_info(${table})`);
      const names = cols.rows.map((r) => r.name);
      assert.ok(names.includes("avatar"), "agents.avatar missing");
      assert.ok(names.includes("onboarded_at"), "agents.onboarded_at missing");
    }
    client.close();
  });

  it("upgrade backfills: grandfathers agents, mints avatars, replaces only the old template prompt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-onboarding-legacy-"));
    const { createClient } = await import("@libsql/client");
    const legacy = createClient({ url: `file:${path.join(dir, "legacy.db")}` });
    // Pre-onboarding agents table shape (no avatar / onboarded_at columns).
    await legacy.execute(
      "CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, provider_config_id TEXT NOT NULL, model TEXT NOT NULL, system_prompt TEXT, created_at INTEGER NOT NULL)",
    );
    const oldPrompt =
      "You are Orion, the user's personal superintelligent agent — not a chat assistant, not one employee among many. There is only you.";
    await legacy.execute({
      sql: "INSERT INTO agents (id, project_id, name, provider_config_id, model, system_prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: ["a-old", "p1", "Orion", "pc1", "m", oldPrompt, Date.now()],
    });
    await legacy.execute({
      sql: "INSERT INTO agents (id, project_id, name, provider_config_id, model, system_prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: ["a-custom", "p1", "Custom", "pc1", "m", "My hand-written custom prompt.", Date.now()],
    });
    legacy.close();

    const { client, db } = openDatabase(path.join(dir, "legacy.db"));
    await runMigrations(client);

    const oldRow = (await db.select().from(agents).where(eq(agents.id, "a-old")).limit(1))[0];
    assert.ok(oldRow.onboardedAt, "legacy agent must be grandfathered as onboarded");
    assert.ok(parseAvatarSpec(oldRow.avatar), "legacy agent must get a minted avatar spec");
    assert.match(oldRow.systemPrompt, /Jsi Orion/, "old template prompt must be replaced by the Czech persona");
    assert.ok(!oldRow.systemPrompt.includes("superintelligent"), "old English prompt must be gone");

    const customRow = (await db.select().from(agents).where(eq(agents.id, "a-custom")).limit(1))[0];
    assert.ok(customRow.onboardedAt, "custom agent also grandfathered");
    assert.equal(customRow.systemPrompt, "My hand-written custom prompt.", "customized prompt must be preserved");

    // Second run must not touch anything (idempotent, no re-grandfathering).
    await runMigrations(client);
    const again = (await db.select().from(agents).where(eq(agents.id, "a-old")).limit(1))[0];
    assert.equal(again.avatar, oldRow.avatar, "avatar must be stable across migration reruns");
    client.close();
  });
});
