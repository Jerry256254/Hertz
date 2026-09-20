import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { consecutiveRepeatCount, toolCallSignature } from "../dist/agent/agent-loop.js";

describe("spin guard signatures", () => {
  it("produces stable signatures regardless of key order", () => {
    const a = toolCallSignature("read_file", { path: "/x", limit: 5 });
    const b = toolCallSignature("read_file", { limit: 5, path: "/x" });
    assert.equal(a, b);
  });

  it("distinguishes different tools and inputs", () => {
    assert.notEqual(toolCallSignature("read_file", { path: "/x" }), toolCallSignature("read_file", { path: "/y" }));
    assert.notEqual(toolCallSignature("read_file", { path: "/x" }), toolCallSignature("glob", { path: "/x" }));
  });

  it("counts consecutive repeats from the tail", () => {
    assert.equal(consecutiveRepeatCount([]), 0);
    assert.equal(consecutiveRepeatCount(["a", "a", "a"]), 3);
    assert.equal(consecutiveRepeatCount(["a", "b", "b"]), 2);
    assert.equal(consecutiveRepeatCount(["a", "a", "b", "a"]), 1);
  });
});
