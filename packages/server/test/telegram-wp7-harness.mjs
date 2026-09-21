// Shared harness for the Telegram WP7 test suites (each test file runs in its
// own process, so shared helpers live here instead of in a sibling file).
import { TelegramDriver } from "../dist/channels/telegram.js";
import { telegramHelpText } from "../dist/channels/telegram-commands.js";
import { parseChannelCommand } from "../dist/channels/types.js";
import { markdownToTelegramHtml, chunkTelegramHtml } from "../dist/channels/telegram-format.js";
import { screenLinkFor } from "../dist/channels/screen-link.js";
import { ChannelManager } from "../dist/channels/manager.js";
import { verifyScreenToken } from "../dist/secrets/screen-token.js";
import { encryptSecret } from "../dist/secrets/key-encryption.js";
import { resolveHertzPaths } from "../dist/paths.js";
import { runMigrations } from "../dist/db/migrate.js";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import * as schema from "../dist/db/schema.js";

export {
  TelegramDriver, telegramHelpText, parseChannelCommand,
  markdownToTelegramHtml, chunkTelegramHtml, screenLinkFor,
  ChannelManager, verifyScreenToken, encryptSecret, resolveHertzPaths,
  runMigrations, drizzle, createClient, eq, schema,
};

export const FAST = { editThrottleMs: 30, typingCooldownMs: 10, typingRefreshMs: 30 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

/** Fake Telegram Bot API. Returns { calls, queueUpdate, fetch }. */
export function makeMock() {
  const calls = [];
  const updateQueue = [];
  const mock = {
    calls,
    queueUpdate: (u) => updateQueue.push([u]),
    fetch: async (url, opts) => {
      const method = String(url).split("/").pop();
      const body = opts?.body ? JSON.parse(opts.body) : {};
      calls.push({ method, body });
      const ok = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
      if (method === "getMe") return ok({ id: 7, username: "hertztestbot" });
      if (method === "getUpdates") {
        await sleep(5);
        return ok(updateQueue.shift() ?? []);
      }
      if (method === "sendMessage") return ok({ message_id: 100 + calls.length, chat: { id: body.chat_id } });
      return ok(true);
    },
  };
  return mock;
}

let nextMessageId = 1000;

export function tgMessage(updateId, chatId, text, messageId = nextMessageId++) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId, type: "private" },
      from: { id: 9, username: "tester", first_name: "Test" },
      date: 1,
      text,
    },
  };
}

export function tgCallback(updateId, chatId, data) {
  return {
    update_id: updateId,
    callback_query: {
      id: "q1",
      from: { id: 9 },
      message: { message_id: 11, chat: { id: chatId, type: "private" } },
      data,
    },
  };
}

// Pictographs, dingbats, misc symbols, emoji presentation selectors (mirrors web's no-emoji test).
export const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2C00}-\u{2FEF}\u{FE0F}\u{200D}\u{3030}\u{303D}\u{3297}\u{3299}\u{A9}\u{AE}\u{203C}\u{2049}]/u;
