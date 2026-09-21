import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripEmoji, hasEmoji } from "../dist/text/strip-emoji.js";
import { defaultAgentPrompt, onboardingPromptBlock } from "../dist/agents/persona.js";
import { buildSystemPrompt } from "../dist/agents/system-prompt.js";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";

describe("stripEmoji", () => {
  it("odstraní typické emoji a uklidí mezery", () => {
    assert.equal(stripEmoji("Ahoj! 👋 Jsem tady."), "Ahoj! Jsem tady.");
    assert.equal(stripEmoji("Hotovo ✅ díky 😀"), "Hotovo díky");
  });

  it("odstraní vlajky, ZWJ sekvence a tóny pleti", () => {
    assert.equal(stripEmoji("Vlajka 🇨🇿 hotovo"), "Vlajka hotovo");
    assert.equal(stripEmoji("rodina 👨‍👩‍👧‍👦"), "rodina");
    assert.equal(stripEmoji("mávnutí 👋🏽"), "mávnutí");
  });

  it("odstraní klávesy, srdce s VS16 a varování", () => {
    assert.equal(stripEmoji("klávesa 1️⃣ a #️⃣"), "klávesa a");
    assert.equal(stripEmoji("srdce ❤️"), "srdce");
    assert.equal(stripEmoji("pozor ⚠️"), "pozor");
  });

  it("nechá legitimní text nedotčený", () => {
    assert.equal(stripEmoji("© 2026 KucLab"), "© 2026 KucLab");
    assert.equal(stripEmoji("cena 100 Kč • sleva → 50 % ★"), "cena 100 Kč • sleva → 50 % ★");
    assert.equal(stripEmoji("letadlo ✈ a slunce ☀"), "letadlo ✈ a slunce ☀");
    assert.equal(stripEmoji("žádné emoji tady"), "žádné emoji tady");
    assert.equal(stripEmoji("a  b   c"), "a  b   c");
    assert.equal(stripEmoji(""), "");
  });

  it("vrátí identický řetězec, když není co odstranit", () => {
    const plain = "obyčejný text © 2026";
    assert.ok(stripEmoji(plain) === plain, "musí vrátit stejnou instanci");
  });

  it("hasEmoji detekuje emoji", () => {
    assert.equal(hasEmoji("Ahoj 👋"), true);
    assert.equal(hasEmoji("Hotovo ✅"), true);
    assert.equal(hasEmoji("obyčejný text ©"), false);
    assert.equal(hasEmoji(""), false);
  });
});

describe("persona — nuancované emoji pravidlo", () => {
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/u;

  it("defaultAgentPrompt má nové pravidlo a NE tvrdý zákaz", () => {
    const p = defaultAgentPrompt("Hertz");
    assert.ok(!/projekt/i.test(p), "persona nesmí obsahovat 'projekt'");
    assert.ok(!EMOJI_RE.test(p), "persona nesmí obsahovat literal emoji");
    assert.ok(!/TVRDÝ ZÁKAZ/.test(p), "persona nesmí obsahovat tvrdý zákaz emoji");
    assert.ok(/střídmě/i.test(p), "persona musí obsahovat nové pravidlo (střídmé emoji v konverzaci)");
    assert.ok(/UI|ui|nadpisy/i.test(p), "persona musí zakazovat emoji v UI textech");
    assert.ok(p.includes("Hertz"), "jméno agenta je v personě");
  });

  it("onboardingPromptBlock je bez tvrdého zákazu a bez literal emoji", () => {
    const b = onboardingPromptBlock("Hertz");
    assert.ok(!/projekt/i.test(b), "onboarding nesmí obsahovat 'projekt'");
    assert.ok(!EMOJI_RE.test(b), "onboarding nesmí obsahovat literal emoji");
    assert.ok(!/TVRDÝ ZÁKAZ/.test(b), "onboarding nesmí obsahovat tvrdý zákaz emoji");
  });

  it("plný system prompt má nové pravidlo a NE tvrdý zákaz", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-emoji-"));
    const { client, db } = openDatabase(path.join(dir, "test.db"));
    try {
      await runMigrations(client);
      const prompt = await buildSystemPrompt(db, {
        id: "agent-1",
        name: "Hertz",
        systemPrompt: defaultAgentPrompt("Hertz"),
        onboardedAt: new Date(),
      });
      assert.ok(!/projekt/i.test(prompt), "sestavený prompt nesmí obsahovat 'projekt'");
      assert.ok(!EMOJI_RE.test(prompt), "sestavený prompt nesmí obsahovat literal emoji");
      assert.ok(!/TVRDÝ ZÁKAZ/.test(prompt), "sestavený prompt nesmí obsahovat tvrdý zákaz emoji");
      assert.ok(/střídmě/i.test(prompt), "sestavený prompt musí obsahovat nové pravidlo");
    } finally {
      client.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizace emoji — konverzace prochází, systém se čistí", () => {
  const SRC = new URL("../src/", import.meta.url);

  async function readSrc(rel) {
    return fs.readFile(new URL(rel, SRC), "utf8");
  }

  /** Extract a class method body by name (2-space indented class). */
  function methodBody(source, name) {
    const re = new RegExp(`private async ${name}\\([\\s\\S]*?\\n  \\}`, "g");
    const m = source.match(re);
    assert.ok(m && m.length > 0, `metoda ${name} musí existovat`);
    return m[0];
  }

  it("channels/manager.ts: konverzační cesty se nečistí", async () => {
    const manager = await readSrc("channels/manager.ts");
    assert.ok(!/stripEmoji/.test(methodBody(manager, "broadcast")), "broadcast (konverzace) nesmí čistit emoji");
    assert.ok(!/stripEmoji/.test(methodBody(manager, "finishStreams")), "finishStreams (konverzace) nesmí čistit emoji");
    assert.ok(!/stripEmoji/.test(methodBody(manager, "updateStreams")), "updateStreams (konverzace) nesmí čistit emoji");
  });

  it("channels/manager.ts: systémové cesty se čistí", async () => {
    const manager = await readSrc("channels/manager.ts");
    assert.ok(/stripEmoji/.test(methodBody(manager, "broadcastSystem")), "broadcastSystem (chyby) musí čistit emoji");
    const approvalMatch = manager.match(/buildApprovalCard\(\{[\s\S]*?\}\)/);
    assert.ok(approvalMatch && /stripEmoji/.test(approvalMatch[0]), "approval karta musí čistit emoji");
  });

  it("ws/session-hub.ts: konverzační eventy se nečistí", async () => {
    const hub = await readSrc("ws/session-hub.ts");
    const sanitizer = hub.match(/function sanitizeEventForWeb\([\s\S]*?\n\}/)?.[0];
    assert.ok(sanitizer, "sanitizeEventForWeb musí existovat");
    assert.ok(!/text_delta/.test(sanitizer), "text_delta se nesmí čistit");
    assert.ok(!/message_saved/.test(sanitizer), "message_saved se nesmí čistit");
    // Otázka ask_user karty je systémové UI — ta se čistit má.
    assert.ok(/awaiting_input/.test(sanitizer) && /stripEmoji/.test(sanitizer), "awaiting_input otázka (UI karta) se čistit má");
  });

  it("routes/sessions.ts: historie asistenta se nečistí, pendingQuestion karta ano", async () => {
    const routes = await readSrc("routes/sessions.ts");
    assert.ok(!/scrubAssistantMessage/.test(routes), "scrubAssistantMessage nesmí existovat");
    assert.ok(/pendingQuestion[\s\S]{0,200}stripEmoji|stripEmoji\(q\)/.test(routes), "pendingQuestion karta se čistit má");
  });

  it("channels/telegram.ts: approval karta se čistí", async () => {
    const telegram = await readSrc("channels/telegram.ts");
    assert.ok(/stripEmoji/.test(telegram), "telegram driver musí čistit systémové karty");
  });
});
