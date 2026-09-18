import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkText, isNewChatCommand, parseDecisionCommand } from "../dist/channels/types.js";
import { encryptSecret, decryptSecret, maskKey } from "../dist/secrets/key-encryption.js";
import { monthStartUtc } from "../dist/usage/quota.js";
import crypto from "node:crypto";

describe("channel text chunking", () => {
  it("keeps short texts whole", () => {
    assert.deepEqual(chunkText("hello", 4096), ["hello"]);
  });

  it("splits long texts under the limit without losing content", () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i} with some words`).join("\n\n");
    const chunks = chunkText(text, 200);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 200, `chunk too long: ${chunk.length}`);
    assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  });
});

describe("channel commands", () => {
  it("parses approve/reject commands", () => {
    assert.deepEqual(parseDecisionCommand("/approve abc123"), { approvalId: "abc123", decision: "approved" });
    assert.deepEqual(parseDecisionCommand("!reject xyz-9_"), { approvalId: "xyz-9_", decision: "rejected" });
    assert.deepEqual(parseDecisionCommand("/deny q"), { approvalId: "q", decision: "rejected" });
  });

  it("rejects non-commands", () => {
    assert.equal(parseDecisionCommand("please approve this"), undefined);
    assert.equal(parseDecisionCommand("/approve"), undefined);
    assert.equal(parseDecisionCommand("/approve a b"), undefined);
  });

  it("detects new-chat commands", () => {
    assert.ok(isNewChatCommand("/new"));
    assert.ok(isNewChatCommand("!reset"));
    assert.ok(!isNewChatCommand("/new idea for lunch"));
    assert.ok(!isNewChatCommand("hello"));
  });
});

describe("secret encryption", () => {
  const key = crypto.randomBytes(32);

  it("round-trips through encrypt/decrypt", () => {
    const cipher = encryptSecret(key, "123456:ABC-DEF-token");
    assert.equal(decryptSecret(key, cipher), "123456:ABC-DEF-token");
  });

  it("produces different ciphertexts for the same input (random IV)", () => {
    assert.notEqual(encryptSecret(key, "same"), encryptSecret(key, "same"));
  });

  it("masks keys for display without leaking the middle", () => {
    assert.equal(maskKey("1234567890abcdef"), "1234••••cdef");
    assert.ok(!maskKey("1234567890abcdef").includes("7890ab"));
    assert.equal(maskKey("short"), "••••");
  });
});

describe("quota month boundaries", () => {
  it("computes the UTC month start", () => {
    assert.equal(monthStartUtc(new Date("2026-09-18T10:00:00Z")).toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(monthStartUtc(new Date("2026-01-31T23:59:59Z")).toISOString(), "2026-01-01T00:00:00.000Z");
  });
});
