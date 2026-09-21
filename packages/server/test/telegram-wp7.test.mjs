/**
 * WORK PACKAGE 7 — Telegram parity with the web UI.
 * Integration tests against a mocked Telegram Bot API (no live token needed):
 * streaming throttle, typing, dedup, restart, inline callbacks, the Czech
 * command surface, approvals from Telegram, and signed screen links.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, and } from "drizzle-orm";

import { TelegramDriver } from "../dist/channels/telegram.js";
import { parseChannelCommand, isChannelCommand } from "../dist/channels/types.js";
import { handleTelegramCommand, telegramHelpText } from "../dist/channels/telegram-commands.js";
import { ChannelManager } from "../dist/channels/manager.js";
import { markdownToTelegramHtml } from "../dist/channels/telegram-format.js";
import { screenLinkFor } from "../dist/channels/screen-link.js";
import { verifyScreenToken } from "../dist/secrets/screen-token.js";
import { encryptSecret } from "../dist/secrets/key-encryption.js";
import * as schema from "../dist/db/schema.js";
import { runMigrations } from "../dist/db/migrate.js";
import { resolveHertzPaths } from "../dist/paths.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

// --- Telegram Bot API mock ---------------------------------------------------

function createTgMock() {
  const calls = [];
  const updateQueue = [];
  let msgId = 100;
  const lastEdit = new Map();
  const mock = {
    calls,
    queueUpdate(u) {
      updateQueue.push([u]);
    },
    fetch: async (url, opts) => {
      const method = String(url).split("/").pop();
      const body = JSON.parse(opts.body);
      calls.push({ method, body });
      const ok = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
      const fail = (description) => ({ ok: true, json: async () => ({ ok: false, description }) });
      switch (method) {
        case "getMe":
          return ok({ id: 7, username: "hertztestbot" });
        case "deleteWebhook":
        case "answerCallbackQuery":
        case "sendChatAction":
        case "deleteMessage":
          return ok(true);
        case "getUpdates":
          if (updateQueue.length === 0) {
            await sleep(5);
            return ok([]);
          }
          return ok(updateQueue.shift());
        case "sendMessage":
          return ok({ message_id: ++msgId, chat: { id: body.chat_id, type: "private" } });
        case "editMessageText": {
          const key = `${body.chat_id}:${body.message_id}`;
          if (lastEdit.get(key) === body.text) return fail("Bad Request: message is not modified");
          lastEdit.set(key, body.text);
          return ok(true);
        }
        default:
          return ok(true);
      }
    },
  };
  return mock;
}

let mock;
let realFetch;

beforeEach(() => {
  mock = createTgMock();
  realFetch = globalThis.fetch;
  globalThis.fetch = mock.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const FAST = { editThrottleMs: 50, typingCooldownMs: 15, typingRefreshMs: 40, seenCacheSize: 100 };

function tgMessage(updateId, chatId, text, messageId = 11) {
  return {
    update_id: updateId,
    message: { message_id: messageId, chat: { id: chatId, type: "private" }, from: { id: 9, username: "tester" }, text },
  };
}

function tgCallback(updateId, chatId, data, queryId = "q1") {
  return {
    update_id: updateId,
    callback_query: {
      id: queryId,
      from: { id: 9, username: "tester" },
      message: { message_id: 11, chat: { id: chatId, type: "private" } },
      data,
    },
  };
}

describe("TelegramDriver polling", () => {
  /** Runs the callback with a started driver, always stopping it afterwards. */
  async function withDriver(fn, opts = FAST) {
    const driver = new TelegramDriver("TOKEN", opts);
    try {
      return await fn(driver);
    } finally {
      driver.stop();
    }
  }

  it("delivers messages and dedupes redelivered updates", async () => {
    await withDriver(async (driver) => {
      const received = [];
      await driver.start({ onMessage: async (m) => received.push(m), onDecision: async () => {} });
      mock.queueUpdate(tgMessage(1, 42, "ahoj"));
      await waitFor(() => received.length === 1);
      assert.equal(received[0].externalChatId, "telegram:42");
      assert.equal(received[0].text, "ahoj");
      assert.equal(received[0].senderLabel, "@tester");

      // Same update delivered again (Telegram redelivery) — must not double-handle.
      mock.queueUpdate(tgMessage(1, 42, "ahoj"));
      await sleep(80);
      assert.equal(received.length, 1);

      // Same message content under a NEW update id still arrives once per update.
      mock.queueUpdate(tgMessage(2, 42, "ahoj", 12));
      await waitFor(() => received.length === 2);
    });
  });

  it("routes approve/reject callbacks to onDecision in Czech", async () => {
    await withDriver(async (driver) => {
      const decisions = [];
      await driver.start({ onMessage: async () => {}, onDecision: async (chat, id, d) => decisions.push({ chat, id, d }) });
      mock.queueUpdate(tgCallback(3, 42, "approve:abc123"));
      await waitFor(() => decisions.length === 1);
      assert.deepEqual(decisions[0], { chat: "telegram:42", id: "abc123", d: "approved" });
      const answer = mock.calls.find((c) => c.method === "answerCallbackQuery");
      assert.equal(answer.body.text, "Schváleno");
    });
  });

  it("routes tgcmd picker callbacks to onCommandCallback", async () => {
    await withDriver(async (driver) => {
      const picked = [];
      await driver.start({
        onMessage: async () => {},
        onDecision: async () => {},
        onCommandCallback: async (chat, action, payload) => picked.push({ chat, action, payload }),
      });
      mock.queueUpdate(tgCallback(4, 42, "tgcmd:model:pc1"));
      await waitFor(() => picked.length === 1);
      assert.deepEqual(picked[0], { chat: "telegram:42", action: "model", payload: "pc1" });
    });
  });

  it("restart() keeps the offset and does not deadlock when called mid-loop", async () => {
    await withDriver(async (driver) => {
      const received = [];
      let restarted = false;
      await driver.start({
        onMessage: async (m) => {
          received.push(m.text);
          if (m.text === "restart me") {
            // Called from INSIDE the poll loop — must not self-deadlock.
            await driver.restart();
            restarted = true;
          }
        },
        onDecision: async () => {},
      });
      mock.queueUpdate(tgMessage(10, 42, "restart me"));
      await waitFor(() => restarted, 5000);
      assert.ok(driver.isPolling());
      // After restart the stream still works and old updates are not replayed.
      mock.queueUpdate(tgMessage(10, 42, "restart me"));
      mock.queueUpdate(tgMessage(11, 42, "after restart", 13));
      await waitFor(() => received.includes("after restart"), 5000);
      assert.deepEqual(received, ["restart me", "after restart"]);
    });
  });
});

describe("TelegramDriver streaming", () => {
  async function withDriver(fn, opts = FAST) {
    const driver = new TelegramDriver("TOKEN", opts);
    try {
      return await fn(driver);
    } finally {
      driver.stop();
    }
  }

  it("throttles edits to ~1/s and re-arms typing", async () => {
    await withDriver(async (driver) => {
      const stream = await driver.beginStream("telegram:42", "začínám");
      assert.ok(stream, "stream should open");

      const t0 = Date.now();
      await stream.update("začínám pracovat");
      await stream.update("začínám pracovat na úkolu");
      await stream.update("začínám pracovat na úkolu X");
      const elapsed = Date.now() - t0;
      // Three rapid updates: first flushes immediately, the rest coalesce.
      assert.ok(elapsed < 900, `rapid updates must not block (${elapsed}ms)`);
      await sleep(1200);
      await stream.finish("začínám pracovat na úkolu X — hotovo");

      const edits = mock.calls.filter((c) => c.method === "editMessageText");
      assert.ok(edits.length <= 4, `edits must be throttled, got ${edits.length}`);
      assert.ok(edits.length >= 2, "expected at least the immediate and the final edit");
      assert.ok(edits[edits.length - 1].body.text.includes("hotovo"), "final edit renders the completed text");
      const typing = mock.calls.filter((c) => c.method === "sendChatAction");
      assert.ok(typing.length >= 2, `typing bubble must be re-armed, got ${typing.length}`);
    }, { ...FAST, editThrottleMs: 1000, typingRefreshMs: 60 });
  });

  it("finish('') removes the placeholder instead of littering the chat", async () => {
    await withDriver(async (driver) => {
      const stream = await driver.beginStream("telegram:42", "");
      assert.ok(stream);
      await stream.finish("");
      const deletes = mock.calls.filter((c) => c.method === "deleteMessage");
      assert.equal(deletes.length, 1);
    });
  });

  it("keeps long streamed replies under the API limit without losing content", async () => {
    await withDriver(async (driver) => {
      const stream = await driver.beginStream("telegram:42", "");
      assert.ok(stream);
      await stream.update("x".repeat(6000));
      await sleep(150);
      const longText = "y".repeat(6000);
      await stream.finish(longText);
      await sleep(100);
      // Every payload Telegram-bound stays within the limit…
      for (const c of mock.calls) {
        if (c.method === "editMessageText" || c.method === "sendMessage") {
          assert.ok(c.body.text.length <= 4096, `${c.method} too long: ${c.body.text.length}`);
        }
      }
      // …and the whole reply survives: first chunk edits the placeholder in
      // place, the rest arrive as follow-up messages.
      const edits = mock.calls.filter((c) => c.method === "editMessageText");
      const extra = mock.calls.filter((c) => c.method === "sendMessage" && c.body.text !== "…");
      assert.ok(edits.length >= 1, "placeholder should be edited");
      const reconstructed = edits[edits.length - 1].body.text + extra.map((c) => c.body.text).join("");
      assert.ok(reconstructed.length >= 6000, `lost content: ${reconstructed.length}`);
      assert.ok(/^y+$/.test(reconstructed.replace(/<[^>]+>/g, "")), "content must be the y-run");
    });
  });

  it("falls back to undefined when the placeholder cannot be sent", async () => {
    await withDriver(async (driver) => {
      const origFetch = mock.fetch;
      globalThis.fetch = async (url, opts) => {
        if (String(url).endsWith("/sendMessage")) {
          return { ok: true, json: async () => ({ ok: false, description: "chat not found" }) };
        }
        return origFetch(url, opts);
      };
      try {
        const stream = await driver.beginStream("telegram:42", "ahoj");
        assert.equal(stream, undefined);
      } finally {
        globalThis.fetch = mock.fetch;
      }
    });
  });
});

describe("command parsing", () => {
  const cases = [
    ["/pomoc", "pomoc", ""],
    ["!help", "pomoc", ""],
    ["/start", "pomoc", ""],
    ["/stav", "stav", ""],
    ["/status", "stav", ""],
    ["/restart", "restart", ""],
    ["/odpojit", "odpojit", ""],
    ["/novy", "novy", ""],
    ["/new", "novy", ""],
    ["/vycistit", "vycistit", ""],
    ["/clear", "vycistit", ""],
    ["/jmeno Karel", "jmeno", "Karel"],
    ["/model", "model", ""],
    ["/model gpt-4o-mini", "model", "gpt-4o-mini"],
    ["/rezim autonomni", "rezim", "autonomni"],
    ["/chaty", "chaty", ""],
    ["/pamet", "pamet", ""],
    ["/zapamatuj koupit mléko", "zapamatuj", "koupit mléko"],
    ["/zapomen abc123", "zapomen", "abc123"],
    ["/hledej dovolená", "hledej", "dovolená"],
    ["/skilly", "skilly", ""],
    ["/pauza", "pauza", ""],
    ["/pokracuj", "pokracuj", ""],
    ["/schvaleni", "schvaleni", ""],
    ["/schvalit abc", "schvalit", "abc"],
    ["/approve abc", "schvalit", "abc"],
    ["/zamitnout abc", "zamitnout", "abc"],
    ["/reject abc", "zamitnout", "abc"],
    ["/obrazovka", "obrazovka", ""],
    ["/screen", "obrazovka", ""],
  ];
  for (const [input, name, args] of cases) {
    it(`parses "${input}"`, () => {
      assert.deepEqual(parseChannelCommand(input), { name, args });
      assert.ok(isChannelCommand(input));
    });
  }

  it("rejects plain text and unknown commands", () => {
    assert.equal(parseChannelCommand("ahoj, jak se máš"), undefined);
    assert.equal(parseChannelCommand("/neexistujicí příkaz"), undefined);
    assert.equal(parseChannelCommand("/usr/bin"), undefined);
    // /projekty was removed — no projects in the product anymore; it now goes
    // to the agent as a plain message instead of being a command.
    assert.equal(parseChannelCommand("/projekty"), undefined);
    assert.ok(!isChannelCommand("/projekty"));
    assert.ok(!isChannelCommand("schvalit abc"));
  });

  it("no-arg commands with trailing text are NOT commands (go to the agent)", async () => {
    let sent = 0;
    const env = { driver: { sendText: async () => sent++ } };
    assert.equal(await handleTelegramCommand(env, { externalChatId: "telegram:1", senderLabel: "t", senderId: "1", text: "/novy nápad na dárek" }), false);
    assert.equal(await handleTelegramCommand(env, { externalChatId: "telegram:1", senderLabel: "t", senderId: "1", text: "/stav systému" }), false);
    assert.equal(sent, 0);
  });
});

describe("telegram help text", () => {
  it("is Czech and has no emoji", () => {
    const help = telegramHelpText();
    assert.ok(help.includes("/schvalit"));
    assert.ok(help.includes("/obrazovka"));
    assert.equal(help.match(EMOJI), null);
  });
});
// Pictographs, dingbats, misc symbols, emoji presentation selectors (mirrors web's no-emoji test).
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2C00}-\u{2FEF}\u{FE0F}\u{200D}\u{3030}\u{303D}\u{3297}\u{3299}\u{00A9}\u{00AE}\u{203C}\u{2049}]/u;
