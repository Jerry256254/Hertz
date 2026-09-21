import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createOpenAICompatibleAdapter } from "../dist/openai-compatible.js";

const realFetch = globalThis.fetch;

function stubModels(ids) {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).endsWith("/models"), `unexpected url ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
      text: async () => "",
    };
  };
}

function makeAdapter() {
  return createOpenAICompatibleAdapter({
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "test-key",
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("openai-compatible listModels", () => {
  it("treats a non-empty live /models list as authoritative (no curated ids injected)", async () => {
    stubModels(["deepseek-flash", "deepseek-v4-pro"]);
    const ids = (await makeAdapter().listModels()).map((m) => m.id);
    assert.deepEqual(ids, ["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("falls back to curated ids when /models returns an empty list", async () => {
    stubModels([]);
    const ids = (await makeAdapter().listModels()).map((m) => m.id);
    assert.ok(ids.includes("deepseek-flash"), ids.join(","));
    assert.ok(ids.includes("deepseek-v4.1-flash"), ids.join(","));
  });

  it("propagates /models failures instead of masking them with curated ids", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => "bad key",
      json: async () => ({}),
    });
    await assert.rejects(() => makeAdapter().listModels(), /listModels failed/);
  });
});
