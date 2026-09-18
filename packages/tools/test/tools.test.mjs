import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALL_TOOLS, getTool } from "../dist/registry.js";
import { webSearchTool } from "../dist/web/search.js";
import { imageGenTool } from "../dist/media/image-gen.js";
import { speakTextTool, transcribeAudioTool } from "../dist/media/voice.js";

describe("tool registry", () => {
  it("exposes the expected tool set", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const expected of [
      "read_file", "write_file", "edit_file", "glob", "grep", "shell_exec",
      "web_fetch", "web_search", "todo_write", "generate_image", "transcribe_audio", "speak_text",
    ]) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
  });

  it("getTool resolves every registered tool", () => {
    for (const tool of ALL_TOOLS) {
      assert.equal(getTool(tool.name)?.name, tool.name);
    }
    assert.equal(getTool("no_such_tool"), undefined);
  });
});

describe("web_search schema", () => {
  it("accepts a query and optional count", () => {
    assert.ok(webSearchTool.inputSchema.safeParse({ query: "hello" }).success);
    assert.ok(webSearchTool.inputSchema.safeParse({ query: "hello", count: 3 }).success);
  });

  it("rejects empty queries and out-of-range counts", () => {
    assert.ok(!webSearchTool.inputSchema.safeParse({ query: "" }).success);
    assert.ok(!webSearchTool.inputSchema.safeParse({ query: "x", count: 0 }).success);
    assert.ok(!webSearchTool.inputSchema.safeParse({ query: "x", count: 11 }).success);
  });
});

describe("generate_image schema", () => {
  it("accepts prompt with default or explicit size", () => {
    assert.ok(imageGenTool.inputSchema.safeParse({ prompt: "a cat" }).success);
    assert.ok(imageGenTool.inputSchema.safeParse({ prompt: "a cat", size: "1792x1024" }).success);
  });

  it("rejects empty prompts and unknown sizes", () => {
    assert.ok(!imageGenTool.inputSchema.safeParse({ prompt: "" }).success);
    assert.ok(!imageGenTool.inputSchema.safeParse({ prompt: "x", size: "100x100" }).success);
  });
});

describe("voice schemas", () => {
  it("transcribe_audio requires a path", () => {
    assert.ok(transcribeAudioTool.inputSchema.safeParse({ path: "a.mp3" }).success);
    assert.ok(!transcribeAudioTool.inputSchema.safeParse({}).success);
  });

  it("speak_text requires text within limits", () => {
    assert.ok(speakTextTool.inputSchema.safeParse({ text: "ahoj" }).success);
    assert.ok(!speakTextTool.inputSchema.safeParse({ text: "" }).success);
    assert.ok(!speakTextTool.inputSchema.safeParse({ text: "x".repeat(4001) }).success);
  });
});
