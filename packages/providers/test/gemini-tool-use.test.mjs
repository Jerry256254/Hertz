import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createGoogleAdapter } from "../dist/google.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(body) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Google adapter: functionCall must yield tool_use", () => {
  it("STOP + functionCall → stopReason tool_use (tools actually execute)", async () => {
    stubFetch({
      candidates: [
        {
          index: 0,
          finishReason: "STOP",
          content: {
            parts: [{ functionCall: { name: "read_file", args: { path: "/x.txt" } } }],
          },
        },
      ],
    });
    const adapter = createGoogleAdapter({ apiKey: "k" });
    const res = await adapter.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    assert.equal(res.stopReason, "tool_use");
    const toolUse = res.content.find((b) => b.type === "tool_use");
    assert.ok(toolUse, "expected a tool_use block");
    assert.equal(toolUse.name, "read_file");
    assert.deepEqual(toolUse.input, { path: "/x.txt" });
  });

  it("STOP without functionCall stays end_turn", async () => {
    stubFetch({
      candidates: [{ index: 0, finishReason: "STOP", content: { parts: [{ text: "hello" }] } }],
    });
    const adapter = createGoogleAdapter({ apiKey: "k" });
    const res = await adapter.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    assert.equal(res.stopReason, "end_turn");
  });

  it("safety-blocked response (no candidates) throws ProviderError, not TypeError", async () => {
    stubFetch({ promptFeedback: { blockReason: "SAFETY" } });
    const adapter = createGoogleAdapter({ apiKey: "k" });
    await assert.rejects(
      () => adapter.chat({ model: "gemini-2.5-flash", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
      (err) => {
        assert.ok(err instanceof Error && !(err instanceof TypeError));
        assert.match(err.message, /SAFETY/);
        return true;
      },
    );
  });
});
