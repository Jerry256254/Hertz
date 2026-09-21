import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");

let client;

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: {
      GOOGLE_CLIENT_ID: "cid",
      GOOGLE_CLIENT_SECRET: "sec",
      GOOGLE_REFRESH_TOKEN: "refresh",
      GOOGLE_ENABLED_APIS: "gmail,calendar,drive",
    },
  });
  client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client.close().catch(() => {});
});

describe("mcp-google tool surface", () => {
  it("registers gmail, calendar and drive tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of [
      "gmail_search_messages",
      "gmail_get_message",
      "gmail_send_message",
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_create_event",
      "calendar_delete_event",
      "drive_search_files",
      "drive_get_file_content",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}; got: ${names.join(",")}`);
    }
  });

  it("respects GOOGLE_ENABLED_APIS filtering", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverJs],
      env: {
        GOOGLE_CLIENT_ID: "cid",
        GOOGLE_CLIENT_SECRET: "sec",
        GOOGLE_REFRESH_TOKEN: "refresh",
        GOOGLE_ENABLED_APIS: "gmail",
      },
    });
    const c2 = new Client({ name: "test2", version: "0.0.0" }, { capabilities: {} });
    await c2.connect(transport);
    try {
      const { tools } = await c2.listTools();
      const names = tools.map((t) => t.name);
      assert.ok(names.includes("gmail_search_messages"));
      assert.ok(!names.some((n) => n.startsWith("calendar_")), "calendar tools must be hidden");
      assert.ok(!names.some((n) => n.startsWith("drive_")), "drive tools must be hidden");
    } finally {
      await c2.close().catch(() => {});
    }
  });
});
