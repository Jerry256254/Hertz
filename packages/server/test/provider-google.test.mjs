import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { providerConfigs, users } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import { addProviderConfig } from "../dist/bootstrap.js";
import { decryptSecret, maskKey } from "../dist/secrets/key-encryption.js";
import { createProviderAdapter } from "@kuclab-hertz/providers";

/**
 * Full provider lifecycle for a Google API key (the "Vlož API klíč z Google AI
 * Studia" flow): create → encrypted in DB → masked in the list → key is
 * usable by the google adapter and never leaks through the mask.
 */
describe("google provider with API key", () => {
  let db;
  let ctx;
  const apiKey = "AIzaSyD-abcdefghijklmnopqrstuvwxyz0123";

  before(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-google-prov-"));
    const opened = openDatabase(path.join(dir, "test.db"));
    await runMigrations(opened.client);
    db = opened.db;
    ctx = { db, masterKey: crypto.randomBytes(32) };
    await db.insert(users).values({ id: "user-1", email: "test@example.com", passwordHash: "x", createdAt: new Date() });
  });

  it("stores the google provider with an encrypted API key", async () => {
    const id = await addProviderConfig(ctx, "user-1", {
      provider: "google",
      label: "Gemini",
      apiKey,
      defaultModel: "gemini-2.5-flash",
    });
    assert.ok(id, "no id returned");
    const rows = await db.select().from(providerConfigs).where(eq(providerConfigs.id, id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, "google");
    assert.equal(rows[0].label, "Gemini");
    assert.equal(rows[0].defaultModel, "gemini-2.5-flash");
    // The stored value is encrypted — never the raw key.
    assert.ok(!rows[0].encryptedKey.includes(apiKey), "raw API key stored in plaintext");
    assert.equal(decryptSecret(ctx.masterKey, rows[0].encryptedKey), apiKey);
  });

  it("masks the key the AQ.A••••JxKA way without leaking the middle", async () => {
    const rows = await db.select().from(providerConfigs).where(eq(providerConfigs.label, "Gemini"));
    const hint = maskKey(decryptSecret(ctx.masterKey, rows[0].encryptedKey));
    assert.equal(hint, `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`);
    assert.ok(!hint.includes(apiKey.slice(10, 20)), "masked hint leaks key material");
  });

  it("creates a working google adapter from the stored key", () => {
    const adapter = createProviderAdapter("google", { apiKey });
    assert.equal(adapter.id, "google");
    assert.equal(typeof adapter.listModels, "function");
    assert.equal(typeof adapter.chat, "function");
  });
});
