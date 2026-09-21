/**
 * WORK PACKAGE 7 — Telegram parity with the web UI, part 2.
 * ChannelManager integration against an in-memory DB and the mocked Bot API:
 * the Czech command surface, approvals (incl. the approve: callback buttons),
 * agent reply streaming through the manager, and signed screen links.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  ChannelManager, verifyScreenToken, encryptSecret, resolveHertzPaths,
  runMigrations, drizzle, createClient, eq, schema,
  screenLinkFor, markdownToTelegramHtml, telegramHelpText,
  sleep, waitFor, makeMock, tgMessage, tgCallback, EMOJI,
} from "./telegram-wp7-harness.mjs";

let mock;
let realFetch;

beforeEach(() => {
  mock = makeMock();
  realFetch = globalThis.fetch;
  globalThis.fetch = mock.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function makeDb() {
  const client = createClient({ url: ":memory:" });
  await runMigrations(client);
  return drizzle(client, { schema });
}

async function seed(db, masterKey) {
  const now = new Date();
  await db.insert(schema.users).values({ id: "user1", email: "boss@example.com", passwordHash: "x", role: "admin", createdAt: now });
  await db.insert(schema.projects).values({ id: "proj1", name: "Test projekt", createdAt: now });
  await db.insert(schema.providerConfigs).values({ id: "pc1", userId: "user1", provider: "anthropic", label: "Anthropic", encryptedKey: "x", defaultModel: "claude-x", createdAt: now });
  await db.insert(schema.providerConfigs).values({ id: "pc2", userId: "user1", provider: "openai", label: "OpenAI", encryptedKey: "x", defaultModel: "gpt-x", createdAt: now });
  await db.insert(schema.agents).values({ id: "agent1", projectId: "proj1", name: "Hertz", providerConfigId: "pc1", model: "claude-x", createdAt: now });
  await db.insert(schema.channelConfigs).values({
    id: "cfg1", kind: "telegram", label: "Test bot",
    encryptedToken: encryptSecret(masterKey, "123:token"),
    defaultAgentId: "agent1", enabled: true, createdAt: now,
  });
}

/**
 * A ChannelManager on the real startup path (token decrypt -> driver verify ->
 * long-poll), with a stub runtime. Returns everything the tests need to drive it.
 */
async function makeManager(t) {
  const masterKey = crypto.randomBytes(32);
  const db = await makeDb();
  await seed(db, masterKey);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-tg-"));
  t.after(async () => fs.rm(tmp, { recursive: true, force: true }));
  const listeners = new Map();
  const enqueued = [];
  const appended = [];
  const agentLoop = {
    _running: false,
    isRunning: () => agentLoop._running,
    appendInbound: async (sid, content) => appended.push({ sid, content }),
    pause: async () => true,
    resume: async () => true,
    subscribe: (sid, fn) => { listeners.set(sid, fn); return () => listeners.delete(sid); },
  };
  const deps = {
    db,
    masterKey,
    agentLoop,
    persistence: { listMessages: async () => [] },
    queue: { enqueue: async (kind, payload) => { enqueued.push({ kind, payload }); return "job1"; } },
    audit: { record: async () => {} },
    paths: resolveHertzPaths(tmp),
    desktop: { start: async () => ({}) },
    fallbackUserId: async () => "user1",
  };
  const manager = new ChannelManager(deps);
  await manager.start();
  t.after(() => manager.stop());
  assert.ok(manager.isRunning("cfg1"), "channel must come up on the real startup path");
  // TS-private, but this is a test: grab the driver to tune stream throttling.
  const driver = manager.running.get("cfg1").driver;
  return { db, masterKey, manager, driver, deps, listeners, enqueued, appended, tmp };
}

function botSends(method = "sendMessage") {
  return mock.calls.filter((c) => c.method === method);
}

function lastBotText() {
  const sends = botSends();
  return sends.length ? sends[sends.length - 1].body.text : "";
}

async function sendViaBot(text, chatId = 42) {
  const updateId = 100000 + Math.floor(Math.random() * 899999);
  mock.queueUpdate(tgMessage(updateId, chatId, text));
  const before = botSends().length;
  await waitFor(() => botSends().length > before, 5000);
}

const inbound = (text) => ({ externalChatId: "telegram:42", senderLabel: "@t", senderId: "9", text });

describe("Telegram commands (ChannelManager)", () => {
  it("/jmeno renames the agent, in Czech", async (t) => {
    const { db, manager, driver } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("/jmeno Karel"));
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, "agent1"));
    assert.equal(rows[0].name, "Karel");
    assert.match(lastBotText(), /Karel/);
  });

  it("/jmeno without args shows usage", async (t) => {
    const { manager, driver } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("/jmeno"));
    assert.match(lastBotText(), /Použití/);
  });

  it("/rezim switches the session mode", async (t) => {
    const { db, manager, driver } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("/rezim autonomni"));
    const bindings = await db.select().from(schema.channelBindings);
    const sRows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, bindings[0].sessionId));
    assert.equal(sRows[0].mode, "autonomous");
    assert.match(lastBotText(), /autonomní/);
  });

  it("/stav reports bot, agent, model and mode", async (t) => {
    const { manager, driver } = await makeManager(t);
    // /stav needs a bound chat — a plain message creates it.
    await manager.handleMessage("cfg1", driver, inbound("ahoj"));
    await manager.handleMessage("cfg1", driver, inbound("/stav"));
    const text = lastBotText();
    assert.match(text, /Test bot/);
    assert.match(text, /Hertz/);
    assert.match(text, /Anthropic/);
  });

  it("/pamet, /zapamatuj, /zapomen and /hledej manage memory", async (t) => {
    const { db, manager, driver } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("/zapamatuj Testovací poznámka o projektu"));
    assert.match(lastBotText(), /Uloženo/);
    await manager.handleMessage("cfg1", driver, inbound("/pamet"));
    assert.match(lastBotText(), /Testovací poznámka/);
    await manager.handleMessage("cfg1", driver, inbound("/hledej projekt"));
    assert.match(lastBotText(), /Testovací poznámka/);

    const atoms = await db.select().from(schema.agentMemoryAtoms);
    assert.equal(atoms.length, 1);
    await manager.handleMessage("cfg1", driver, inbound(`/zapomen ${atoms[0].id.slice(0, 8)}`));
    assert.match(lastBotText(), /Zapomenuto/);
    assert.equal((await db.select().from(schema.agentMemoryAtoms)).length, 0);
  });

  it("/skilly lists installed skills", async (t) => {
    const { manager, driver, tmp } = await makeManager(t);
    const dir = path.join(tmp, "projects", "proj1", "employees", "agent1", "skills", "demo");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: demo\ndescription: Ukázkový skill pro test\n---\n# Demo\n");
    await manager.handleMessage("cfg1", driver, inbound("/skilly"));
    assert.match(lastBotText(), /demo/);
  });

  it("/model offers an inline picker and the callback switches provider", async (t) => {
    const { db, manager, driver } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("/model"));
    const sends = botSends();
    const picker = sends[sends.length - 1];
    const buttons = picker.body.reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some((b) => b.callback_data === "tgcmd:model:pc2"), "picker must offer pc2");

    await manager.handleCommandCallback("cfg1", driver, "telegram:42", "model", "pc2", "@t");
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, "agent1"));
    assert.equal(rows[0].providerConfigId, "pc2");
    assert.equal(rows[0].model, "gpt-x");
    assert.match(lastBotText(), /OpenAI/);
  });

  it("/pauza and /pokracuj pause and resume the loop", async (t) => {
    const { db, manager, driver, deps } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("/pauza"));
    assert.match(lastBotText(), /nic neběží/);
    // /novy wipes the binding; the next plain message starts a fresh bound chat.
    await manager.handleMessage("cfg1", driver, inbound("/novy"));
    await manager.handleMessage("cfg1", driver, inbound("ahoj"));
    const bindings = await db.select().from(schema.channelBindings);
    assert.equal(bindings.length, 1);
    deps.agentLoop._running = true;
    const paused = [];
    deps.agentLoop.pause = async (sid) => { paused.push(sid); return true; };
    await manager.handleMessage("cfg1", driver, inbound("/pauza"));
    assert.deepEqual(paused, [bindings[0].sessionId]);
    assert.match(lastBotText(), /Pozastaveno/);
    await manager.handleMessage("cfg1", driver, inbound("/pokracuj"));
    assert.match(lastBotText(), /Pokračuji/);
  });

  it("/restart restarts the poll loop from inside the loop", async (t) => {
    const { manager } = await makeManager(t);
    await sendViaBot("/restart");
    assert.match(lastBotText(), /příjem zpráv běží znovu/);
    assert.ok(manager.isRunning("cfg1"));
    // The bot still answers afterwards.
    await sendViaBot("/pomoc");
    assert.match(lastBotText(), /Co umím/);
  });

  it("/odpojit asks for confirmation and then disables the channel", async (t) => {
    const { db, manager, driver } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("/odpojit"));
    const sends = botSends();
    const confirm = sends[sends.length - 1];
    assert.ok(confirm.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "tgcmd:odpojit:ano"));
    await manager.handleCommandCallback("cfg1", driver, "telegram:42", "odpojit", "ano", "@t");
    const rows = await db.select().from(schema.channelConfigs).where(eq(schema.channelConfigs.id, "cfg1"));
    assert.equal(rows[0].enabled, false);
    assert.ok(!manager.isRunning("cfg1"));
    assert.match(lastBotText(), /odpojený/);
  });

  it("/obrazovka returns a signed screen link that verifies", async (t) => {
    const { manager, driver, masterKey } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("/obrazovka"));
    const text = lastBotText();
    const m = /http:\/\/[^\s]+\/screen\/([A-Za-z0-9_-]+)\?t=([A-Za-z0-9_.-]+)/.exec(text);
    assert.ok(m, `expected a signed screen link, got: ${text}`);
    assert.equal(m[1], "agent1");
    assert.ok(verifyScreenToken(masterKey, m[2], "agent1"), "screen token must verify");
  });

  it("plain text goes to the agent, not the command router", async (t) => {
    const { manager, driver, enqueued } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("Ahoj, co umíš?"));
    assert.equal(enqueued.length, 1);
    // /novy with trailing text is a chat message too (old /new semantics).
    await manager.handleMessage("cfg1", driver, inbound("/novy nápad na dárek"));
    assert.equal(enqueued.length, 2);
  });

  it("/model with a model id sets the model directly on the current provider", async (t) => {
    const { db, manager, driver } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("ahoj"));
    await manager.handleMessage("cfg1", driver, inbound("/model gpt-4o-mini"));
    const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, "agent1"));
    assert.equal(rows[0].model, "gpt-4o-mini");
    assert.equal(rows[0].providerConfigId, "pc1");
    assert.match(lastBotText(), /gpt-4o-mini/);
  });

  it("/schvalit decides a pending approval (generic kind)", async (t) => {
    const { db, manager, driver } = await makeManager(t);
    // A plain message binds this chat to a fresh session first.
    await manager.handleMessage("cfg1", driver, inbound("ahoj"));
    const bindings = await db.select().from(schema.channelBindings);
    const sessionId = bindings[0].sessionId;
    await db.insert(schema.approvals).values({
      id: "appr1", projectId: "proj1", agentId: "agent1", sessionId,
      summary: "Poslat e-mail", detail: "Nabídka pro klienta", kind: "generic",
      status: "pending", createdAt: new Date(),
    });
    await manager.handleMessage("cfg1", driver, inbound("/schvaleni"));
    const sends = botSends();
    const approvalMsg = sends[sends.length - 1];
    assert.ok(approvalMsg.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "approve:appr1"));

    await manager.handleMessage("cfg1", driver, inbound("/schvalit appr1"));
    const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.id, "appr1"));
    assert.equal(rows[0].status, "approved");
    assert.match(lastBotText(), /Schváleno: Poslat e-mail/);
  });

  it("approve: callback button decides the approval end to end", async (t) => {
    const { db, manager, driver } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("ahoj"));
    const bindings = await db.select().from(schema.channelBindings);
    await db.insert(schema.approvals).values({
      id: "appr2", projectId: "proj1", agentId: "agent1", sessionId: bindings[0].sessionId,
      summary: "Smazat soubor", kind: "generic", status: "pending", createdAt: new Date(),
    });
    mock.queueUpdate(tgCallback(9001, 42, "approve:appr2"));
    await waitFor(async () => (await db.select().from(schema.approvals).where(eq(schema.approvals.id, "appr2")))[0].status === "approved", 5000);
    assert.match(lastBotText(), /Schváleno: Smazat soubor/);
  });

  it("vault_use approval from Telegram mints the grant like the WebUI", async (t) => {
    const { db, manager, driver, masterKey, appended } = await makeManager(t);
    const { createVaultCredential } = await import("../dist/secrets/vault.js");
    const { consumeVaultGrantForFill } = await import("../dist/tools/vault-tools.js");
    const meta = await createVaultCredential(db, masterKey, {
      service: "test-service", label: "Testovací účet", username: "tester", secret: "s3cr3t-heslo",
    });
    await manager.handleMessage("cfg1", driver, inbound("ahoj"));
    const bindings = await db.select().from(schema.channelBindings);
    const sessionId = bindings[0].sessionId;
    await db.insert(schema.approvals).values({
      id: "appr-vault", projectId: "proj1", agentId: "agent1", sessionId,
      summary: "Použít přihlášení do test-service",
      kind: "vault_use", status: "pending", createdAt: new Date(),
      payload: JSON.stringify({ credentialId: meta.id, purpose: "přihlášení" }),
    });
    await manager.handleMessage("cfg1", driver, inbound("/schvalit appr-vault"));
    const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.id, "appr-vault"));
    assert.equal(rows[0].status, "approved");
    // The grant exists server-side for this session…
    const grant = consumeVaultGrantForFill(sessionId);
    assert.equal(grant.secret, "s3cr3t-heslo");
    // …but the secret never leaks into the chat reply or the resumed prompt.
    assert.ok(!lastBotText().includes("s3cr3t-heslo"), "secret must not leak into chat");
    const inboundTexts = appended.filter((a) => a.sid === sessionId).map((a) => JSON.stringify(a.content)).join(" ");
    assert.ok(!inboundTexts.includes("s3cr3t-heslo"), "secret must not leak into the agent prompt");
  });

  it("deciding an unknown approval says it is no longer pending", async (t) => {
    const { manager, driver } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("/zamitnout neexistuje"));
    assert.match(lastBotText(), /už nečeká/);
  });
});

describe("agent reply streaming through ChannelManager", () => {
  it("streams text_deltas as throttled edits, then finalizes in place", async (t) => {
    const { manager, driver, listeners, enqueued } = await makeManager(t);
    driver.opts.editThrottleMs = 60;
    await manager.handleMessage("cfg1", driver, inbound("napiš báseň"));
    assert.equal(enqueued.length, 1);
    const sessionId = enqueued[0].payload.sessionId;
    const emit = listeners.get(sessionId);
    assert.ok(emit, "tap must subscribe to the session");

    await emit({ type: "tool_call", id: "c1", name: "read_file", input: {} });
    // Placeholder for the live stream is up, plus the typing indicator.
    await waitFor(() => mock.calls.some((c) => c.method === "sendChatAction"), 3000);

    const parts = ["Ahoj, ", "tady je ", "báseň ", "o ", "jablkách."];
    for (const p of parts) {
      await emit({ type: "text_delta", text: p });
      await sleep(15);
    }
    await emit({ type: "done" });
    await waitFor(() => {
      const edits = botSends("editMessageText");
      return edits.length > 0 && edits[edits.length - 1].body.text.includes("jablkách");
    }, 5000);

    const edits = botSends("editMessageText");
    assert.ok(edits.length < parts.length + 3, `edits must be throttled/coalesced, got ${edits.length}`);
    // No duplicate wall-of-text message after the stream.
    assert.equal(botSends().length, 1, `expected only the stream placeholder send, got ${botSends().length}`);
    assert.ok(!listeners.has(sessionId), "tap must be dropped after done");
  });

  it("tool-only runs leave no placeholder litter", async (t) => {
    const { manager, driver, listeners, enqueued } = await makeManager(t);
    await manager.handleMessage("cfg1", driver, inbound("zkontroluj to"));
    const sessionId = enqueued[0].payload.sessionId;
    const emit = listeners.get(sessionId);
    await emit({ type: "tool_call", id: "c1", name: "shell_exec", input: {} });
    await waitFor(() => botSends().length > 0, 3000);
    await emit({ type: "done" });
    await waitFor(() => botSends("deleteMessage").length > 0, 3000);
  });
});

describe("screen links", () => {
  it("screenLinkFor mints a verifiable token link", () => {
    const masterKey = crypto.randomBytes(32);
    const link = screenLinkFor(masterKey, "agent9");
    if (!link) {
      assert.ok(true, "no LAN ip in this environment — null is acceptable");
      return;
    }
    const m = /\/screen\/agent9\?t=([A-Za-z0-9_.-]+)/.exec(link);
    assert.ok(m, `link shape wrong: ${link}`);
    assert.ok(verifyScreenToken(masterKey, m[1], "agent9"));
    assert.ok(!verifyScreenToken(masterKey, m[1], "agentX"), "token must be bound to the agent");
  });
});

describe("telegram format tables", () => {
  it("renders markdown tables as aligned monospace blocks", () => {
    const html = markdownToTelegramHtml("| Jméno | Věk |\n|---|---|\n| Karel | 30 |\n| Alena Dlouhá | 25 |");
    assert.ok(html.includes("<pre>"), `expected a pre block, got: ${html}`);
    assert.ok(!html.includes("|"), "pipes must be gone");
    const tags = [...html.matchAll(/<\/?([a-z]+)[\s>]/g)].map((m) => m[1]);
    for (const tag of tags) assert.ok(["b", "i", "s", "code", "pre", "blockquote", "a"].includes(tag), `forbidden tag <${tag}>`);
  });

  it("leaves pipe text that is not a table alone", () => {
    const html = markdownToTelegramHtml("a | b je jen text");
    assert.ok(!html.includes("<pre>"), `not a table: ${html}`);
  });
});

describe("no emoji in telegram channel sources", () => {
  it("channels/*.ts and the help text stay emoji-free", async () => {
    const dir = new URL("../src/channels/", import.meta.url);
    let count = 0;
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".ts")) continue;
      count++;
      const text = await fs.readFile(new URL(name, dir), "utf8");
      assert.equal(text.match(EMOJI), null, `emoji found in channels/${name}`);
    }
    assert.ok(count >= 5, "expected to scan the channel sources");
    assert.equal(telegramHelpText().match(EMOJI), null, "emoji found in help text");
  });
});
