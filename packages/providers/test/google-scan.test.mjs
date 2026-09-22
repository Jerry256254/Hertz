import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createGoogleAdapter } from "../dist/google.js";
import { describeScanError } from "../dist/scan-errors.js";

const realFetch = globalThis.fetch;

function stubListModels(page) {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).startsWith("https://generativelanguage.googleapis.com/v1beta/models"), `unexpected url ${url}`);
    assert.ok(String(url).includes("key="), "API key missing from the listModels URL");
    return {
      ok: true,
      status: 200,
      json: async () => page,
      text: async () => "",
    };
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("google listModels (scan)", () => {
  it("keeps generateContent-capable gemini/gemma models, drops the rest", async () => {
    stubListModels({
      models: [
        { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemma-3-27b-it", displayName: "Gemma 3 27B", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
        { name: "tunedModels/my-tuned", displayName: "Tuned", supportedGenerationMethods: ["generateContent"] },
      ],
    });
    const ids = (await createGoogleAdapter({ apiKey: "AIzaSy-test" }).listModels()).map((m) => m.id);
    assert.deepEqual(ids, ["gemini-2.5-flash", "gemma-3-27b-it", "my-tuned"]);
  });

  it("a bad API key produces a Czech scan error, not a raw English body", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => "API key not valid. Please pass a valid API key.",
      json: async () => ({}),
    });
    let thrown;
    try {
      await createGoogleAdapter({ apiKey: "bad-key" }).listModels();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "expected listModels to throw");
    const msg = describeScanError(thrown, "google");
    assert.ok(msg.includes("Seznam modelů se nepodařilo načíst"), `not a Czech scan error: ${msg}`);
    assert.ok(msg.includes("Model jde napsat ručně"), `missing manual fallback hint: ${msg}`);
    assert.ok(!msg.includes("bad-key"), "scan error leaks the API key");
  });
});
