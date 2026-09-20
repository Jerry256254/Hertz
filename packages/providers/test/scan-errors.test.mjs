import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeScanError } from "../dist/scan-errors.js";
import { ProviderError } from "../dist/types.js";

describe("describeScanError", () => {
  it("explains localhost from the server side", () => {
    const msg = describeScanError(new TypeError("fetch failed"), "openai-compatible", "http://localhost:11434/v1");
    assert.match(msg, /localhost/);
    assert.match(msg, /LAN adresu/);
    assert.match(msg, /ručně/);
  });

  it("covers 127.0.0.1 and refused connections", () => {
    const msg = describeScanError(
      new ProviderError("openai-compatible", "fetch failed", undefined),
      "openai-compatible",
      "http://127.0.0.1:1234/v1",
    );
    assert.match(msg, /127\.0\.0\.1/);
    assert.match(msg, /LAN adresu/);
  });

  it("reports remote connection failures with the URL", () => {
    const msg = describeScanError(new Error("connect ECONNREFUSED 1.2.3.4:443"), "openai", undefined);
    assert.match(msg, /nedokáže připojit/);
  });

  it("maps 401 to a bad-key hint", () => {
    const msg = describeScanError(new ProviderError("anthropic", "listModels failed: auth error", 401), "anthropic");
    assert.match(msg, /API klíč/);
    assert.match(msg, /401/);
  });

  it("maps 404 to a baseUrl hint", () => {
    const msg = describeScanError(new ProviderError("x", "listModels failed: nope", 404), "openai-compatible", "https://x.test/api");
    assert.match(msg, /\/v1/);
    assert.match(msg, /https:\/\/x\.test\/api/);
  });

  it("maps 429 to a retry hint", () => {
    const msg = describeScanError(new ProviderError("x", "slow down", 429), "openai");
    assert.match(msg, /Rate limit|rate limit/);
  });

  it("scrubs credentials from echoed urls and truncates long bodies", () => {
    const msg = describeScanError(
      new Error("connect ECONNREFUSED"),
      "openai-compatible",
      "https://user:s3cret@models.example.com/v1",
    );
    assert.ok(!msg.includes("s3cret"), "url password must not leak into the message");
    assert.match(msg, /models\.example\.com/);
    const long = describeScanError(new Error("boom " + "x".repeat(500)), "anthropic");
    assert.ok(long.length < 600);
  });
});
