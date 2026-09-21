import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSupportedModel } from "../dist/model-normalization.js";

const DEEPSEEK_GATEWAY = ["deepseek-flash", "deepseek-v4-pro"];

describe("resolveSupportedModel", () => {
  it("maps deepseek-v4.1-flash to deepseek-flash via alias", () => {
    const r = resolveSupportedModel("deepseek-v4.1-flash", DEEPSEEK_GATEWAY, "deepseek-flash");
    assert.equal(r.model, "deepseek-flash");
    assert.equal(r.changed, true);
    assert.equal(r.via, "alias");
  });

  it("prefers the alias over the default when both would fit", () => {
    const r = resolveSupportedModel("deepseek-v4.1-flash", ["deepseek-v4-pro", "deepseek-flash"], "deepseek-v4-pro");
    assert.equal(r.model, "deepseek-flash");
    assert.equal(r.via, "alias");
  });

  it("falls back to the configured default for a fully unknown model", () => {
    const r = resolveSupportedModel("gpt-99-turbo", DEEPSEEK_GATEWAY, "deepseek-flash");
    assert.equal(r.model, "deepseek-flash");
    assert.equal(r.changed, true);
    assert.equal(r.via, "default");
  });

  it("falls back to the first supported model when no default is set", () => {
    const r = resolveSupportedModel("gpt-99-turbo", DEEPSEEK_GATEWAY);
    assert.equal(r.model, "deepseek-flash");
    assert.equal(r.via, "first");
  });

  it("leaves an exact match untouched", () => {
    const r = resolveSupportedModel("deepseek-flash", DEEPSEEK_GATEWAY, "deepseek-v4-pro");
    assert.deepEqual(r, { model: "deepseek-flash", changed: false, via: "exact" });
  });

  it("strips version infixes as a fallback heuristic", () => {
    const r = resolveSupportedModel("llama-v3.2-8b", ["llama-8b"]);
    assert.equal(r.model, "llama-8b");
    assert.equal(r.via, "alias");
  });

  it("matches case-insensitively", () => {
    const r = resolveSupportedModel("DeepSeek-Flash", DEEPSEEK_GATEWAY);
    assert.equal(r.model, "deepseek-flash");
    assert.equal(r.changed, true);
  });

  it("passes through unverified when the supported list is unknown (scan failed)", () => {
    const r = resolveSupportedModel("deepseek-v4.1-flash", [], "deepseek-flash");
    assert.deepEqual(r, { model: "deepseek-v4.1-flash", changed: false, via: "unverified" });
  });
});
