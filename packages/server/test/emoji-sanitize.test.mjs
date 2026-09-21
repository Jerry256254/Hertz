import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

describe("persona bez projektového rámování a bez emoji", () => {
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/u;

  it("defaultAgentPrompt neobsahuje slovo projekt", () => {
    const p = defaultAgentPrompt("Hertz");
    assert.ok(!/projekt/i.test(p), "persona nesmí obsahovat 'projekt'");
    assert.ok(!EMOJI_RE.test(p), "persona nesmí obsahovat emoji");
  });

  it("persona má tvrdý zákaz emoji", () => {
    const p = defaultAgentPrompt("Hertz");
    assert.ok(/TVRDÝ ZÁKAZ/.test(p), "persona musí obsahovat tvrdý zákaz emoji");
    assert.ok(p.includes("Hertz"), "jméno agenta je v personě");
  });

  it("onboardingPromptBlock je bez emoji a bez projektů", () => {
    const b = onboardingPromptBlock("Hertz");
    assert.ok(!/projekt/i.test(b), "onboarding nesmí obsahovat 'projekt'");
    assert.ok(!EMOJI_RE.test(b), "onboarding nesmí obsahovat emoji");
    assert.ok(/bez emoji/i.test(b), "onboarding musí zakazovat emoji v pozdravu");
  });

  it("plný system prompt je bez slova projekt i bez emoji", async () => {
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
      assert.ok(!EMOJI_RE.test(prompt), "sestavený prompt nesmí obsahovat emoji");
    } finally {
      client.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
