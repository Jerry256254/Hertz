/**
 * WORK PACKAGE 8 — Telegram na úroveň Hermese (mock testy, bez sítě).
 * - streamování: placeholder + throttlované edity, dlouhé zprávy do nových
 *   zpráv, fallback na plain text při parse chybě, zrušení streamu
 * - schvalovací karta: 3 tlačítka, callback approve-session, expirace
 * - /model picker: poskytovatel → model přes callbacky, editace na místě
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  TelegramDriver, runMigrations, drizzle, createClient, eq, schema,
  sleep, waitFor, makeMock, tgCallback, FAST, EMOJI,
} from "./telegram-wp7-harness.mjs";
import { handleTelegramCallback } from "../dist/channels/telegram-commands.js";
import { buildApprovalCard } from "../dist/channels/approval-card.js";
import { reapExpiredApprovals } from "../dist/tools/approval-reaper.js";
import {
  grantSessionApproval, hasSessionApproval, sessionApprovalKey, sessionGrantInfo, normalizeApprovalSummary,
} from "../dist/tools/session-approval-grants.js";
import { createApprovalTools } from "../dist/tools/approval-tools.js";

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

const editsOf = (method) => mock.calls.filter((c) => c.method === method);

async function makeDb() {
  const client = createClient({ url: ":memory:" });
  await runMigrations(client);
  return drizzle(client, { schema });
}

async function seedBase(db) {
  const now = new Date();
  await db.insert(schema.users).values({ id: "user1", email: "boss@example.com", passwordHash: "x", role: "admin", createdAt: now });
  await db.insert(schema.projects).values({ id: "proj1", name: "Test", createdAt: now });
  await db.insert(schema.providerConfigs).values({ id: "pc1", userId: "user1", provider: "anthropic", label: "Anthropic", encryptedKey: "x", defaultModel: "model-a", createdAt: now });
  await db.insert(schema.agents).values({ id: "agent1", projectId: "proj1", name: "Hertz", providerConfigId: "pc1", model: "model-a", createdAt: now });
  await db.insert(schema.sessions).values({ id: "sess1", agentId: "agent1", projectId: "proj1", title: "Test chat", status: "active", createdAt: now, updatedAt: now });
}

describe("streamování: placeholder + throttlované edity", () => {
  it("pošle placeholder a při rychlých updatech edituje nejvýše párkrát", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    const stream = await driver.beginStream("telegram:1", "");
    assert.ok(stream, "stream se měl otevřít");
    assert.equal(editsOf("sendMessage").length, 1);
    assert.equal(editsOf("sendMessage")[0].body.text, "…");

    for (let i = 1; i <= 10; i++) {
      await stream.update(`text ${i}`);
    }
    await sleep(150);
    const editCalls = editsOf("editMessageText");
    assert.ok(editCalls.length >= 1, "alespoň jeden edit měl proběhnout");
    assert.ok(editCalls.length <= 3, `throttling: čekal jsem <= 3 edity, bylo ${editCalls.length}`);

    await stream.finish("finální text");
    await sleep(50);
    const lastEdit = editsOf("editMessageText").at(-1);
    assert.ok(lastEdit.body.text.includes("finální text"), "finální edit musí nést celý text");
  });

  it("dlouhou odpověď rozdělí: první kus edituje placeholder, zbytek jde novými zprávami", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    const stream = await driver.beginStream("telegram:1", "");
    const long = Array.from({ length: 300 }, (_, i) => `řádek ${i} s nějakým obsahem navrch`).join("\n");
    assert.ok(long.length > 4096, "text musí být delší než limit");
    await stream.finish(long);
    await sleep(50);
    const first = editsOf("editMessageText").at(-1);
    assert.ok(first.body.text.length <= 4096, `první kus <= 4096, bylo ${first.body.text.length}`);
    const followups = editsOf("sendMessage").filter((c) => c.body.text !== "…");
    assert.ok(followups.length >= 1, "očekávám navazující zprávy");
    for (const c of [...editsOf("editMessageText"), ...followups]) {
      assert.ok(c.body.text.length <= 4096, `žádný kus nesmí přesáhnout 4096 (bylo ${c.body.text.length})`);
    }
    const total = [first.body.text, ...followups.map((c) => c.body.text)].join("").length;
    assert.ok(total >= long.length * 0.9, "nesmí se ztratit podstatná část textu");
  });

  it("při parse chybě edituje znovu jako plain text", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const method = String(url).split("/").pop();
      const body = opts?.body ? JSON.parse(opts.body) : {};
      calls.push({ method, body });
      const ok = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
      if (method === "sendMessage") return ok({ message_id: 5, chat: { id: body.chat_id } });
      if (method === "editMessageText" && body.parse_mode === "HTML" && body.text.includes("§BROKEN§")) {
        return { ok: true, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) };
      }
      return ok(true);
    };
    const driver = new TelegramDriver("123:tok", FAST);
    const stream = await driver.beginStream("telegram:1", "");
    await stream.update("ahoj §BROKEN§ <b>neuzavřeno");
    await sleep(150);
    const plainRetry = calls.find((c) => c.method === "editMessageText" && !c.body.parse_mode);
    assert.ok(plainRetry, "po parse chybě se měl edit zopakovat jako plain text");
    await stream.finish("konec");
  });

  it("abort smaže placeholder a dál nic needituje", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    const stream = await driver.beginStream("telegram:1", "");
    await stream.abort();
    const dels = editsOf("deleteMessage");
    assert.equal(dels.length, 1, "placeholder se měl smazat");
    const editsBefore = editsOf("editMessageText").length;
    await stream.update("pozdní text");
    await sleep(80);
    assert.equal(editsOf("editMessageText").length, editsBefore, "po abortu už žádný edit");
  });
});

describe("schvalovací karta", () => {
  const card = (kind, payload) =>
    buildApprovalCard({ summary: "Testovací akce", detail: "Detail akce", kind, payload });

  it("má česky srozumitelný důvod bez emoji pro každý kind", () => {
    const cards = [
      card("generic", null),
      card("host_access", JSON.stringify({ op: "read", hostPath: "/tmp/x", reason: "protože" })),
      card("vault_use", JSON.stringify({ credentialId: "cred1", purpose: "login" })),
      card("mcp_op", JSON.stringify({ serverId: "s1", serverName: "Gmail", toolName: "send", input: {} })),
    ];
    for (const c of cards) {
      assert.ok(c.reason.length > 20, `důvod je moc krátký: ${c.reason}`);
      assert.ok(!EMOJI.test(c.reason), `důvod nesmí mít emoji: ${c.reason}`);
      assert.ok(!EMOJI.test(c.summary), "summary nesmí mít emoji");
    }
    assert.ok(cards[1].reason.includes("/tmp/x"), "host_access důvod zmiňuje cestu");
    assert.ok(cards[3].reason.includes("Gmail"), "mcp_op důvod zmiňuje konektor");
  });

  it("posílá tři tlačítka: Povolit jednou / Zamítnout / Povolit pro session", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    const c = card("generic", null);
    await driver.sendApproval("telegram:1", "appr1", c);
    const sent = editsOf("sendMessage").at(-1);
    assert.ok(sent.body.text.includes("Proč se ptám"), "karta obsahuje důvod");
    const kb = sent.body.reply_markup.inline_keyboard;
    assert.equal(kb.length, 2, "dvě řady tlačítek");
    assert.deepEqual(
      kb[0].map((b) => b.text),
      ["Povolit jednou", "Zamítnout"],
    );
    assert.deepEqual(
      kb[0].map((b) => b.callback_data),
      ["approve:appr1", "reject:appr1"],
    );
    assert.equal(kb[1][0].text, "Povolit pro session");
    assert.equal(kb[1][0].callback_data, "approve-session:appr1");
    assert.ok(!EMOJI.test(sent.body.text), "karta je bez emoji");
  });

  it("callback approve-session dorazí jako approved-session", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    let got;
    await driver.start({
      onMessage: async () => {},
      onDecision: async (chat, id, decision) => {
        got = { chat, id, decision };
      },
    });
    mock.queueUpdate(tgCallback(1, 42, "approve-session:appr9"));
    await waitFor(() => got !== undefined);
    assert.deepEqual(got, { chat: "telegram:42", id: "appr9", decision: "approved-session" });
    const answers = editsOf("answerCallbackQuery");
    assert.ok(answers.at(-1).body.text.includes("session"), "toast potvrzuje session scope");
    driver.stop();
  });
});

describe("expirace schválení + session granty", () => {
  it("reaper zamítne jen prošlá čekající schválení", async () => {
    const db = await makeDb();
    await seedBase(db);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    await db.insert(schema.approvals).values({
      id: "old1", projectId: "proj1", agentId: "agent1", sessionId: "sess1",
      summary: "Stará žádost", kind: "generic", status: "pending", createdAt: old,
    });
    await db.insert(schema.approvals).values({
      id: "fresh1", projectId: "proj1", agentId: "agent1", sessionId: "sess1",
      summary: "Čerstvá žádost", kind: "generic", status: "pending", createdAt: new Date(),
    });
    const expired = await reapExpiredApprovals(db);
    assert.deepEqual(expired.map((e) => e.id), ["old1"]);
    const rows = await db.select().from(schema.approvals);
    assert.equal(rows.find((r) => r.id === "old1").status, "rejected");
    assert.ok(rows.find((r) => r.id === "old1").decidedAt, "expirace má čas rozhodnutí");
    assert.equal(rows.find((r) => r.id === "fresh1").status, "pending");
  });

  it("session grant: udělení, kontrola a grantedBy", () => {
    const key = sessionApprovalKey("generic", normalizeApprovalSummary("Poslat e-mail"));
    assert.ok(!hasSessionApproval("sess1", key), "před udělením nic");
    grantSessionApproval("sess1", key, "user1");
    assert.ok(hasSessionApproval("sess1", key), "po udělení platí");
    assert.deepEqual(sessionGrantInfo("sess1", key), { grantedBy: "user1" });
    assert.ok(!hasSessionApproval("sess2", key), "grant je vázaný na session");
    assert.ok(!hasSessionApproval("sess1", sessionApprovalKey("generic", "neco jineho")), "grant je vázaný na akci");
  });

  it("request_approval s grantem se automaticky schválí bez parkování", async () => {
    const db = await makeDb();
    await seedBase(db);
    const key = sessionApprovalKey("generic", normalizeApprovalSummary("Poslat e-mail Honzovi"));
    grantSessionApproval("sess1", key, "user1");
    const [tool] = createApprovalTools(db);
    const res = await tool.execute(
      { summary: "Poslat e-mail Honzovi", detail: "Nabídka" },
      { actor: { actorId: "agent1", projectId: "proj1", sessionId: "sess1" } },
    );
    assert.ok(res.summary.includes("Automaticky schváleno"), `čekal jsem auto-schválení, bylo: ${res.summary}`);
    assert.ok(!res.awaitUser, "run se neparkuje");
    const rows = await db.select().from(schema.approvals);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "approved");
    assert.equal(rows[0].decidedByUserId, "user1");
  });

  it("request_approval bez grantu parkuje jako dřív", async () => {
    const db = await makeDb();
    await seedBase(db);
    const [tool] = createApprovalTools(db);
    const res = await tool.execute(
      { summary: "Smazat databázi", detail: "Nevratné" },
      { actor: { actorId: "agent1", projectId: "proj1", sessionId: "sess1" } },
    );
    assert.ok(res.awaitUser, "bez grantu se run parkuje");
    const rows = await db.select().from(schema.approvals);
    assert.equal(rows[0].status, "pending");
  });
});

describe("/model picker: poskytovatel → model", () => {
  async function makeEnv(db) {
    const driver = new TelegramDriver("123:tok", FAST);
    return {
      db,
      masterKey: Buffer.alloc(32),
      agentLoop: {},
      paths: {},
      fallbackUserId: async () => "user1",
      configId: "cfg1",
      configLabel: "Test bot",
      driver,
      ensureSession: async () => "sess1",
      boundSessionId: async () => "sess1",
      restartPolling: async () => {},
      setEnabled: async () => {},
      clearChat: async () => true,
      decide: async () => undefined,
      pendingApprovals: async () => [],
      startDesktop: async () => {},
      botPolling: () => true,
      listModels: async () => [
        { id: "model-a", displayName: "Model A", contextWindow: 200000 },
        { id: "model-b", displayName: "Model B", contextWindow: 100000 },
      ],
    };
  }

  it("modelprov edituje zprávu na místě a nabídne modely", async () => {
    const db = await makeDb();
    await seedBase(db);
    const env = await makeEnv(db);
    await handleTelegramCallback(env, "telegram:42", "@tester", "modelprov", "pc1", 777);
    const edit = editsOf("editMessageText").find((c) => c.body.message_id === 777);
    assert.ok(edit, "picker se měl editovat na místě (message_id 777)");
    const buttons = edit.body.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.length, 2);
    assert.deepEqual(buttons.map((b) => b.text), ["Model A", "Model B"]);
    assert.ok(buttons.every((b) => b.callback_data.startsWith("tgcmd:modelpick:")), "callbacky nesou picker id");
  });

  it("modelpick nastaví model a poskytovatele, potvrzení edituje na místě", async () => {
    const db = await makeDb();
    await seedBase(db);
    const env = await makeEnv(db);
    // krok 1: otevřít picker
    await handleTelegramCallback(env, "telegram:42", "@tester", "modelprov", "pc1", 777);
    const payload = editsOf("editMessageText")
      .find((c) => c.body.message_id === 777)
      .body.reply_markup.inline_keyboard.flat()[1].callback_data.split(":")[2];
    // krok 2: vybrat Model B
    await handleTelegramCallback(env, "telegram:42", "@tester", "modelpick", payload, 777);
    const agent = (await db.select().from(schema.agents).where(eq(schema.agents.id, "agent1")))[0];
    assert.equal(agent.model, "model-b");
    assert.equal(agent.providerConfigId, "pc1");
    const confirm = editsOf("editMessageText").at(-1);
    assert.ok(confirm.body.text.includes("model-b"), "potvrzení zmiňuje vybraný model");
    assert.ok(!EMOJI.test(confirm.body.text), "potvrzení je bez emoji");

    // opakované použití stejného pickeru už neprojde
    await handleTelegramCallback(env, "telegram:42", "@tester", "modelpick", payload, 777);
    const expired = editsOf("editMessageText").at(-1);
    assert.ok(expired.body.text.includes("vypršel"), "použitý picker je neplatný");
  });
});
