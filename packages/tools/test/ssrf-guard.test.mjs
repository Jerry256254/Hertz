import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { webFetchTool } from "../dist/web/fetch.js";

// Minimal ToolContext — the SSRF guard rejects before ctx is ever touched.
const ctx = {};

describe("web_fetch SSRF guard", () => {
  it("blocks metadata/loopback/private IPv4 literals", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8000/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://172.16.4.2/x",
    ]) {
      const res = await webFetchTool.execute({ url }, ctx);
      assert.equal(res.isError, true, url);
      assert.match(res.summary, /Blocked/, url);
    }
  });

  it("blocks localhost and IPv6 loopback/link-local", async () => {
    for (const url of ["http://localhost:3000/x", "http://[::1]/x", "http://[fe80::1]/x"]) {
      const res = await webFetchTool.execute({ url }, ctx);
      assert.equal(res.isError, true, url);
      assert.match(res.summary, /Blocked/, url);
    }
  });

  it("blocks non-http(s) protocols", async () => {
    const res = await webFetchTool.execute({ url: "file:///etc/passwd" }, ctx);
    assert.equal(res.isError, true);
    assert.match(res.summary, /Blocked/);
  });
});
