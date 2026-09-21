/**
 * WORK PACKAGE 9 — Telegram jako OpenClaw/Hermes (mock testy, bez sítě).
 * - tool status řádky: kompaktní české popisy tool callů, žádný raw JSON, žádná emoji
 * - streamování: status řádek ve živé zprávě s throttlingem editů, vymazání po tool_result
 * - ovládací tlačítka: Pozastavit/Zastavit na stream zprávě, odstranění po finish
 * - callback routing: tgcmd:pauza / tgcmd:zastavit přes existující approval/command flow
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  TelegramDriver, sleep, waitFor, makeMock, tgCallback, FAST, EMOJI,
} from "./telegram-wp7-harness.mjs";
import { toolStatusLine } from "../dist/channels/tool-status.js";
import { handleTelegramCallback } from "../dist/channels/telegram-commands.js";

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

const KNOWN_TOOLS = [
  "read_file", "write_file", "edit_file", "glob", "grep", "shell_exec",
  "web_search", "web_fetch", "todo_write", "generate_image", "speak_text",
  "transcribe_audio", "send_file", "remember", "save_note", "recall_memory",
  "list_memory", "read_memory_ref", "forget", "update_user_profile", "update_soul",
  "list_skills", "read_skill", "save_skill", "delete_skill", "spawn_subagent",
  "send_to_subagent", "list_subagents", "subagent_status", "stop_subagent",
  "run_in_shell", "create_shell", "share_shell", "list_my_shells",
  "request_approval", "request_host_access", "request_takeover", "vault_use",
  "vault_list", "ask_user", "list_pending_approvals", "list_my_chats",
  "list_my_routines", "complete_onboarding", "regenerate_avatar",
  "browser_navigate", "browser_click", "desktop_read_screen", "mcp__catalog",
  "mcp__gmail__send", "mcp__notion__create_page", "some_future_tool_xyz",
];

describe("toolStatusLine — kompaktní české statusy", () => {
  it("popisuje známé tooly česky s detailem, ne raw JSON", () => {
    assert.equal(toolStatusLine("read_file", { path: "src/a/c.ts" }), "Čtu soubor c.ts…");
    assert.equal(toolStatusLine("write_file", { path: "/x/y/report.md" }), "Zapisuji soubor report.md…");
    assert.equal(toolStatusLine("web_search", { query: "počasí praha" }), "Hledám na webu „počasí praha“…");
    assert.equal(toolStatusLine("web_fetch", { url: "https://example.com/x?y=1" }), "Stahuji stránku example.com…");
    assert.equal(toolStatusLine("shell_exec", { command: "git" }), "Spouštím příkaz git…");
    assert.equal(toolStatusLine("grep", { pattern: "TODO" }), "Hledám v souborech „TODO“…");
    assert.equal(toolStatusLine("ask_user", {}), "Čekám na tvou odpověď…");
    assert.equal(toolStatusLine("spawn_subagent", {}), "Spouštím podagenta…");
    assert.equal(toolStatusLine("browser_navigate", { url: "https://ct24.ceskatelevize.cz/clanek" }), "Otevírám stránku ct24.ceskatelevize.cz…");
  });

  it("pojmenuje MCP konektor, ne technický název toolu", () => {
    assert.equal(toolStatusLine("mcp__gmail__send", {}), "Volám konektor gmail…");
    assert.equal(toolStatusLine("mcp__notion__create_page", { title: "x" }), "Volám konektor notion…");
  });

  it("neznámý tool dostane obecný status, nikdy JSON", () => {
    assert.equal(toolStatusLine("some_future_tool_xyz", { foo: "bar" }), "Pracuji…");
  });

  it("nikdy neleakne celý input (ani secrety), ani s divným inputem", () => {
    const line = toolStatusLine("read_file", { path: "x.ts", apiKey: "SUPERSECRET-123", nested: { a: 1 } });
    assert.ok(!line.includes("SUPERSECRET-123"), "secret nesmí uniknout");
    assert.ok(!line.includes("{"), "žádný raw JSON");
    assert.ok(!line.includes("nested"));
    assert.equal(toolStatusLine("web_search", null), "Hledám na webu…");
    assert.equal(toolStatusLine("web_search", "not-an-object"), "Hledám na webu…");
    const multiline = toolStatusLine("web_search", { query: "a\nb\nc" });
    assert.ok(!multiline.includes("\n"), "status je jednoradkovy");
  });

  it("žádný status neobsahuje emoji (UI text)", () => {
    for (const tool of KNOWN_TOOLS) {
      const line = toolStatusLine(tool, { path: "a/b.ts", query: "dotaz", url: "https://x.cz/y", command: "ls", pattern: "p*" });
      assert.ok(!EMOJI.test(line), `emoji ve statusu pro ${tool}: ${line}`);
      assert.ok(line.length <= 80, `status pro ${tool} je moc dlouhý: ${line}`);
    }
  });
});

describe("stream — status řádek s throttlingem", () => {
  it("placeholder nese ovládací tlačítka Pozastavit/Zastavit (bez emoji, krátká callback data)", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    await driver.beginStream("telegram:1", "");
    const sent = mock.calls.find((c) => c.method === "sendMessage");
    assert.equal(sent.body.text, "…");
    const kb = sent.body.reply_markup.inline_keyboard;
    assert.deepEqual(kb[0].map((b) => b.text), ["Pozastavit", "Zastavit"]);
    assert.deepEqual(kb[0].map((b) => b.callback_data), ["tgcmd:pauza:run", "tgcmd:zastavit:run"]);
    for (const b of kb[0]) {
      assert.ok(b.callback_data.length <= 64, "callback_data nad limit 64 B");
      assert.ok(!EMOJI.test(b.text), "tlačítko nesmí mít emoji");
    }
    driver.stop();
  });

  it("status se renderuje jako kurzíva pod draftem a edity jsou throttlované", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    const stream = await driver.beginStream("telegram:1", "");
    await stream.setStatus("Hledám na webu…");
    for (let i = 0; i < 5; i++) await stream.update(`draft ${i}`);
    await sleep(150);
    const edits = mock.calls.filter((c) => c.method === "editMessageText");
    assert.ok(edits.length <= 3, `moc editů (${edits.length}) — throttling nefunguje`);
    assert.ok(edits.length >= 1, "žádný edit neproběhl");
    const last = edits.at(-1).body.text;
    assert.ok(last.includes("<i>Hledám na webu…</i>"), `status chybí v editaci: ${last}`);
    assert.ok(last.includes("draft 4"), "draft se ztratil");
    assert.ok(!last.includes("{"), "raw JSON ve streamu");
    driver.stop();
  });

  it("setStatus(null) status řádek odstraní", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    const stream = await driver.beginStream("telegram:1", "");
    await stream.setStatus("Čtu soubor…");
    await sleep(100);
    await stream.setStatus(null);
    await sleep(100);
    const edits = mock.calls.filter((c) => c.method === "editMessageText");
    const last = edits.at(-1).body.text;
    assert.ok(!last.includes("<i>"), `status měl zmizet: ${last}`);
    driver.stop();
  });

  it("finish() odstraní status i ovládací tlačítka", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    const stream = await driver.beginStream("telegram:1", "");
    await stream.setStatus("Pracuji…");
    await stream.update("hotovo");
    await sleep(100);
    await stream.finish("hotovo");
    const markupEdits = mock.calls.filter((c) => c.method === "editMessageReplyMarkup");
    assert.ok(markupEdits.length >= 1, "tlačítka nebyla odstraněna");
    assert.deepEqual(markupEdits.at(-1).body.reply_markup, { inline_keyboard: [] });
    const finalEdit = mock.calls.filter((c) => c.method === "editMessageText").at(-1).body.text;
    assert.ok(!finalEdit.includes("<i>"), "finální zpráva nesmí nést status");
    driver.stop();
  });
});

describe("ovládací callbacky pauza/zastavit", () => {
  it("tgcmd:pauza:run a tgcmd:zastavit:run se routují přes onCommandCallback", async () => {
    const driver = new TelegramDriver("123:tok", FAST);
    const routed = [];
    await driver.start({
      onMessage: async () => {},
      onDecision: async () => {},
      onCommandCallback: async (chatId, action, payload, senderLabel, messageId) => {
        routed.push({ chatId, action, payload, senderLabel, messageId });
      },
    });
    mock.queueUpdate(tgCallback(1, 555, "tgcmd:pauza:run"));
    await waitFor(() => routed.length === 1);
    assert.deepEqual(routed[0], {
      chatId: "telegram:555",
      action: "pauza",
      payload: "run",
      senderLabel: "user 9",
      messageId: 11,
    });
    mock.queueUpdate(tgCallback(2, 555, "tgcmd:zastavit:run"));
    await waitFor(() => routed.length === 2);
    assert.equal(routed[1].action, "zastavit");
    driver.stop();
  });

  it("handleTelegramCallback pauza/zastavit pausuje běžící session", async () => {
    const paused = [];
    const sent = [];
    const env = {
      boundSessionId: async () => "sess-1",
      agentLoop: { isRunning: () => true, pause: async (id) => { paused.push(id); } },
      driver: { sendText: async (chat, text) => { sent.push([chat, text]); } },
    };
    await handleTelegramCallback(env, "telegram:1", "@tester", "pauza", "run", 11);
    assert.deepEqual(paused, ["sess-1"]);
    assert.ok(sent[0][1].includes("Pozastaveno"), `špatné potvrzení: ${sent[0][1]}`);
    await handleTelegramCallback(env, "telegram:1", "@tester", "zastavit", "run", 11);
    assert.ok(sent[1][1].includes("Zastaveno"), `špatné potvrzení: ${sent[1][1]}`);
  });

  it("pauza bez běžícího runu hlásí přátelsky, nic nepausuje", async () => {
    let paused = false;
    const sent = [];
    const env = {
      boundSessionId: async () => "sess-1",
      agentLoop: { isRunning: () => false, pause: async () => { paused = true; } },
      driver: { sendText: async (chat, text) => { sent.push(text); } },
    };
    await handleTelegramCallback(env, "telegram:1", "@tester", "pauza", "run", 11);
    assert.equal(paused, false);
    assert.ok(sent[0].includes("nic neběží"), `špatná hláška: ${sent[0]}`);
    assert.ok(!sent[0].includes("{"), "žádný technický výpis");
  });
});
