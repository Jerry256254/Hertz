import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderAdapter } from "../dist/factory.js";

describe("openai-compatible pricing", () => {
  it("prices known xAI models", () => {
    const adapter = createProviderAdapter("openai-compatible", { apiKey: "test", baseUrl: "https://api.x.ai/v1" });
    const grok = adapter.pricing("grok-3-mini");
    assert.ok(grok, "expected pricing for grok-3-mini");
    assert.equal(grok.currency, "USD");
    assert.ok(grok.inputPerMillion > 0 && grok.outputPerMillion > 0);
  });

  it("matches by longest model prefix", () => {
    const adapter = createProviderAdapter("openai-compatible", { apiKey: "test", baseUrl: "https://api.deepseek.com/v1" });
    const dated = adapter.pricing("deepseek-chat-v3-0324");
    assert.ok(dated, "expected prefix-matched pricing");
    assert.equal(dated.inputPerMillion, adapter.pricing("deepseek-chat").inputPerMillion);
  });

  it("returns undefined for unknown hosts instead of guessing", () => {
    const adapter = createProviderAdapter("openai-compatible", { apiKey: "test", baseUrl: "http://localhost:11434/v1" });
    assert.equal(adapter.pricing("llama3"), undefined);
  });
});
