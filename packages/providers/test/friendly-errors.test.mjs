import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { friendlyChatError } from "../dist/friendly-errors.js";
import { ProviderError } from "../dist/types.js";

const RAW_JSON =
  '{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.","type":"invalid_request_error","code":"invalid_model"}}';

describe("friendlyChatError", () => {
  it("turns the raw provider model error into Czech with no JSON", () => {
    const err = new ProviderError("openai-compatible", `stream failed: ${RAW_JSON}`, 400);
    const msg = friendlyChatError(err);
    assert.ok(!msg.includes("{"), "must not contain JSON");
    assert.ok(!msg.includes("}"), "must not contain JSON");
    assert.ok(!msg.includes("invalid_request_error"), "must not leak provider codes");
    assert.ok(!msg.includes("deepseek-v4.1-flash"), "must not echo the raw model name");
    assert.ok(!msg.includes("[openai-compatible]"), "must not leak the provider id prefix");
    assert.match(msg, /model|AI/i);
    assert.ok(/[áčďéěíňóřšťúůýž]/i.test(msg), "should be Czech");
  });

  it("maps auth failures to a key hint", () => {
    const msg = friendlyChatError(new ProviderError("openai", "chat failed: auth error", 401));
    assert.ok(!msg.includes("401"));
    assert.match(msg, /API klíč/);
  });

  it("maps rate limits to a retry hint", () => {
    const msg = friendlyChatError(new ProviderError("anthropic", "chat failed: slow down", 429));
    assert.ok(!msg.includes("429"));
    assert.match(msg, /přetížená|chvíli/);
  });

  it("maps 5xx to a temporary-outage hint", () => {
    const msg = friendlyChatError(new ProviderError("google", "chat failed: boom", 503));
    assert.ok(!msg.includes("503"));
    assert.match(msg, /neodpovídá|chvíli/);
  });

  it("maps network failures without leaking internals", () => {
    const msg = friendlyChatError(new TypeError("fetch failed"));
    assert.ok(!msg.includes("fetch failed"));
    assert.match(msg, /spojit|připojení/);
  });

  it("never returns an empty message for unknown errors", () => {
    const msg = friendlyChatError(new Error("Something weird happened"));
    assert.ok(msg.length > 10);
    assert.ok(!msg.includes("Something weird happened"));
  });
});
