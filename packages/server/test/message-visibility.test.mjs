import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { createPersistenceAdapter } from "../dist/persistence/persistence-adapter.js";
import { messages, sessions, users, projects, providerConfigs, agents } from "../dist/db/schema.js";

const NUDGE_PREFIX = "[Systémová kontrola dokončení";

async function seedCore(db) {
  const now = new Date();
  await db.insert(users).values({ id: "user-1", email: "u@x.y", passwordHash: "h", role: "admin", createdAt: now });
  await db.insert(projects).values({ id: "proj-1", name: "p", createdAt: now });
  await db
    .insert(providerConfigs)
    .values({ id: "pc-1", userId: "user-1", provider: "openai", label: "l", encryptedKey: "k", createdAt: now });
  await db
    .insert(agents)
    .values({ id: "agent-1", projectId: "proj-1", name: "Orion", providerConfigId: "pc-1", model: "m", createdAt: now });
  await db
    .insert(sessions)
    .values({ id: "sess-1", agentId: "agent-1", projectId: "proj-1", title: "t", status: "active", createdAt: now, updatedAt: now });
}

describe("message visibility — hidden flag for internal messages", () => {
  let dir;
  let client;
  let db;
  let adapter;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-visibility-"));
    ({ client, db } = openDatabase(path.join(dir, "test.db")));
    await runMigrations(client);
    await seedCore(db);
    adapter = createPersistenceAdapter(db);
  });

  it("migration adds the hidden column to messages", async () => {
    const cols = await client.execute("PRAGMA table_info(messages)");
    const names = cols.rows.map((r) => r.name);
    assert.ok(names.includes("hidden"), "messages.hidden column exists after migrations");
  });

  it("marks legacy guard-nudge records (role user, no flag) as hidden on read", async () => {
    // Simulate a row written by an older build: role "user", hidden defaults to 0.
    await db.insert(messages).values({
      id: "legacy-nudge-1",
      sessionId: "sess-1",
      role: "user",
      content: JSON.stringify([
        { type: "text", text: `${NUDGE_PREFIX} — tato zpráva není od uživatele] Slíbil jsi uživateli soubor…` },
      ]),
      senderAgentId: null,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      cost: 0,
      purpose: "agent_turn",
      createdAt: new Date(),
    });
    const all = await adapter.listMessages("sess-1");
    const legacy = all.find((m) => m.id === "legacy-nudge-1");
    assert.ok(legacy, "legacy row readable");
    assert.equal(legacy.hidden, true, "legacy internal text is retroactively hidden");
  });

  it("round-trips the hidden flag for newly written internal messages", async () => {
    const saved = await adapter.appendMessage({
      sessionId: "sess-1",
      role: "system",
      hidden: true,
      content: [{ type: "text", text: "[System nudge — not from the user] test" }],
      senderAgentId: null,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      cost: 0,
      purpose: "agent_turn",
    });
    assert.equal(saved.hidden, true);
    const all = await adapter.listMessages("sess-1");
    const back = all.find((m) => m.id === saved.id);
    assert.equal(back.hidden, true, "hidden survives the DB round-trip");
    assert.equal(back.role, "system");
  });

  it("leaves genuine user and assistant messages visible", async () => {
    const userMsg = await adapter.appendMessage({
      sessionId: "sess-1",
      role: "user",
      content: [{ type: "text", text: "ahoj" }],
      senderAgentId: null,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      cost: 0,
      purpose: "agent_turn",
    });
    const asstMsg = await adapter.appendMessage({
      sessionId: "sess-1",
      role: "assistant",
      content: [{ type: "text", text: "Ahoj! Jak ti můžu pomoct?" }],
      senderAgentId: "agent-1",
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      cost: 0,
      purpose: "agent_turn",
    });
    const all = await adapter.listMessages("sess-1");
    assert.ok(!all.find((m) => m.id === userMsg.id).hidden, "user message stays visible");
    assert.ok(!all.find((m) => m.id === asstMsg.id).hidden, "assistant message stays visible");
  });

  it("upgrades a pre-existing messages table without the hidden column", async () => {
    // Old install: messages table in the previous shape (no hidden column).
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-visibility-old-"));
    const opened = openDatabase(path.join(dir2, "old.db"));
    await opened.client.execute(
      `CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sender_agent_id TEXT,
        tool_calls TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cached_tokens_in INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        purpose TEXT NOT NULL DEFAULT 'agent_turn',
        created_at INTEGER NOT NULL
      )`,
    );
    await opened.client.execute(
      `INSERT INTO messages (id, session_id, role, content, purpose, created_at)
       VALUES ('old-1', 'sess-9', 'user', '[{"type":"text","text":"ahoj"}]', 'agent_turn', 1720000000000)`,
    );
    // Must not throw on the already-migrated shape, and must add the column.
    await runMigrations(opened.client);
    const cols = await opened.client.execute("PRAGMA table_info(messages)");
    assert.ok(
      cols.rows.some((r) => r.name === "hidden"),
      "ALTER TABLE migration adds hidden to the old table",
    );
    // Re-running the whole migration suite stays idempotent.
    await runMigrations(opened.client);
    const rows = await opened.client.execute("SELECT id, hidden FROM messages WHERE id = 'old-1'");
    assert.equal(rows.rows[0].hidden, 0, "existing rows default to visible");
    opened.client.close();
  });
});
