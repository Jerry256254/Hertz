import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { knownModelsForEndpoint, mergeModelLists } from "../dist/known-models.js";

describe("knownModelsForEndpoint", () => {
  it("returns DeepSeek V4/V4.1 ids for the first-party endpoint", () => {
    const ids = knownModelsForEndpoint("https://api.deepseek.com/v1").map((m) => m.id);
    assert.ok(ids.includes("deepseek-flash"), ids.join(","));
    assert.ok(ids.includes("deepseek-v4.1-flash"), ids.join(","));
    assert.ok(ids.includes("deepseek-v4-pro"), ids.join(","));
  });

  it("returns nothing for unknown hosts and garbage urls", () => {
    assert.deepEqual(knownModelsForEndpoint("https://api.unknown.example/v1"), []);
    assert.deepEqual(knownModelsForEndpoint("not a url"), []);
  });
});

describe("mergeModelLists", () => {
  it("unions scanned + known with scanned first and no duplicates", () => {
    const scanned = [{ id: "a", displayName: "a", supportsTools: true }];
    const known = [
      { id: "a", displayName: "a-known", supportsTools: false },
      { id: "b", displayName: "b", supportsTools: true },
    ];
    const merged = mergeModelLists(scanned, known);
    assert.deepEqual(merged.map((m) => m.id), ["a", "b"]);
    assert.equal(merged[0].displayName, "a");
  });
});
