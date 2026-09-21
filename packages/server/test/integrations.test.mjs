import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Regression tests for Work Package 9 (second half): one-click OAuth MCP
 * connectors (Google, Notion, GitHub).
 *
 * - OAuth helpers: state signing, auth-URL builders, code exchange against a
 *   local mock provider (no real network).
 * - Connector catalog: shape, Czech copy, server-row matching.
 * - Tool registry: connect registers mcp__<server>__<tool> tools,
 *   disconnect unregisters them; mcp__catalog is always present.
 * - Secrets: tokens are stored encrypted and never appear in API payloads.
 *
 * Pure unit parts run without a server; the route-level part boots the real
 * Fastify app (app.inject) against a mock OAuth provider.
 */

// --- Mock OAuth provider + mock Notion API (one local HTTP server) ---------

const captured = { notionAuthHeader: "", notionVersion: "" };

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const mockServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const body = await readBody(req);
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "POST" && url.pathname === "/mock-google-token") {
    const params = new URLSearchParams(body);
    if (params.get("code") === "no-refresh") return json(200, { access_token: "a", expires_in: 3600, scope: "s" });
    return json(200, { access_token: "mock-google-access", refresh_token: "mock-google-refresh", expires_in: 3600, scope: "s" });
  }
  if (req.method === "POST" && url.pathname === "/mock-notion-token") {
    captured.notionAuthHeader = req.headers.authorization ?? "";
    return json(200, { access_token: "mock-notion-token", workspace_name: "Test WS", workspace_id: "ws-1", bot_id: "bot-1" });
  }
  if (req.method === "POST" && url.pathname === "/mock-github-token") {
    const parsed = JSON.parse(body);
    if (parsed.code === "bad") return json(200, { error: "bad_verification_code", error_description: "The code is wrong." });
    return json(200, { access_token: "mock-github-token", scope: "repo", token_type: "bearer" });
  }
  // Mock Notion API (tool-call end-to-end through the real MCP server binary).
  if (url.pathname === "/v1/search" && req.method === "POST") {
    captured.notionVersion = req.headers["notion-version"] ?? "";
    if (req.headers.authorization !== "Bearer mock-notion-token") return json(401, { message: "unauthorized" });
    return json(200, {
      results: [
        {
          id: "page-1",
          object: "page",
          url: "https://notion.so/page-1",
          properties: { title: { type: "title", title: [{ plain_text: "Testovací stránka" }] } },
        },
      ],
      has_more: false,
    });
  }
  res.writeHead(404);
  res.end("not found");
});

let mockBase = "";
let oauth; // dynamically imported after env overrides are set

before(async () => {
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const addr = mockServer.address();
  mockBase = `http://127.0.0.1:${addr.port}`;
  process.env.HERTZ_OAUTH_GOOGLE_AUTHORIZE_URL = `${mockBase}/mock-google-auth`;
  process.env.HERTZ_OAUTH_GOOGLE_TOKEN_URL = `${mockBase}/mock-google-token`;
  process.env.HERTZ_OAUTH_NOTION_AUTHORIZE_URL = `${mockBase}/mock-notion-auth`;
  process.env.HERTZ_OAUTH_NOTION_TOKEN_URL = `${mockBase}/mock-notion-token`;
  process.env.HERTZ_OAUTH_GITHUB_AUTHORIZE_URL = `${mockBase}/mock-github-auth`;
  process.env.HERTZ_OAUTH_GITHUB_TOKEN_URL = `${mockBase}/mock-github-token`;
  oauth = await import("../dist/oauth/oauth-service.js");
});

after(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
});

const MASTER_KEY = crypto.randomBytes(32);

describe("oauth-service: state signing", () => {
  it("round-trips a signed state payload", () => {
    const payload = { service: "notion", catalogId: "notion", agentId: null, projectId: null, userId: "u1", nonce: "n1" };
    const state = oauth.signState(MASTER_KEY, payload);
    assert.deepEqual(oauth.verifyState(MASTER_KEY, state), payload);
  });

  it("rejects tampered state", () => {
    const payload = { service: "github", catalogId: "github", agentId: null, projectId: null, userId: "u1", nonce: "n1" };
    const state = oauth.signState(MASTER_KEY, payload);
    const [json, sig] = state.split(".");
    const forged = JSON.parse(Buffer.from(json, "base64url").toString("utf8"));
    forged.userId = "attacker";
    const forgedState = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    assert.equal(oauth.verifyState(MASTER_KEY, forgedState), undefined);
  });

  it("rejects garbage state", () => {
    assert.equal(oauth.verifyState(MASTER_KEY, "not-a-state"), undefined);
    assert.equal(oauth.verifyState(MASTER_KEY, ""), undefined);
  });
});

describe("oauth-service: auth URLs and scopes", () => {
  it("google one-click URL requests gmail+drive+calendar+sheets+docs scopes", () => {
    const scopes = oauth.googleScopesFor("google");
    assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.readonly"));
    assert.ok(scopes.includes("https://www.googleapis.com/auth/drive.readonly"));
    assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.readonly"));
    assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events"));
    assert.ok(scopes.includes("https://www.googleapis.com/auth/spreadsheets"));
    assert.ok(scopes.includes("https://www.googleapis.com/auth/documents"));
    const url = new URL(oauth.googleAuthUrl({ clientId: "cid", redirectUri: "https://app/cb", catalogId: "google", state: "s" }));
    assert.equal(url.host, new URL(mockBase).host, "env override for authorize URL is honored");
    assert.ok(url.searchParams.get("scope").includes("calendar"));
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
  });

  it("legacy per-service google scopes still work", () => {
    assert.ok(oauth.googleScopesFor("gmail").some((s) => s.includes("gmail")));
    assert.ok(oauth.googleScopesFor("google-drive").some((s) => s.includes("drive")));
    assert.ok(oauth.googleScopesFor("google-calendar").some((s) => s.includes("calendar")));
  });

  it("notion auth URL carries client_id, redirect_uri and state", () => {
    const url = new URL(oauth.notionAuthUrl({ clientId: "notion-cid", redirectUri: "https://app/api/oauth/notion/callback", state: "st" }));
    assert.equal(url.host, new URL(mockBase).host);
    assert.equal(url.searchParams.get("client_id"), "notion-cid");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("owner"), "user");
    assert.equal(url.searchParams.get("state"), "st");
  });

  it("github auth URL requests repo scope", () => {
    const url = new URL(oauth.githubAuthUrl({ clientId: "gh-cid", redirectUri: "https://app/api/oauth/github/callback", state: "st" }));
    assert.equal(url.host, new URL(mockBase).host);
    assert.ok(url.searchParams.get("scope").split(" ").includes("repo"));
  });
});

describe("oauth-service: code exchange against mock provider", () => {
  it("exchanges a google code for access+refresh tokens", async () => {
    const tokens = await oauth.exchangeGoogleCode({ clientId: "cid", clientSecret: "sec", redirectUri: "https://app/cb", code: "good" });
    assert.equal(tokens.accessToken, "mock-google-access");
    assert.equal(tokens.refreshToken, "mock-google-refresh");
  });

  it("google without refresh token throws a helpful error", async () => {
    await assert.rejects(
      () => oauth.exchangeGoogleCode({ clientId: "cid", clientSecret: "sec", redirectUri: "https://app/cb", code: "no-refresh" }),
      /refresh token/i,
    );
  });

  it("exchanges a notion code with HTTP Basic client auth", async () => {
    const tokens = await oauth.exchangeNotionCode({ clientId: "ncid", clientSecret: "nsec", redirectUri: "https://app/cb", code: "good" });
    assert.equal(tokens.accessToken, "mock-notion-token");
    assert.equal(tokens.workspaceName, "Test WS");
    assert.equal(captured.notionAuthHeader, `Basic ${Buffer.from("ncid:nsec").toString("base64")}`);
  });

  it("exchanges a github code for a token", async () => {
    const tokens = await oauth.exchangeGithubCode({ clientId: "gcid", clientSecret: "gsec", redirectUri: "https://app/cb", code: "good" });
    assert.equal(tokens.accessToken, "mock-github-token");
  });

  it("github error body without access_token throws a Czech-friendly error", async () => {
    await assert.rejects(
      () => oauth.exchangeGithubCode({ clientId: "gcid", clientSecret: "gsec", redirectUri: "https://app/cb", code: "bad" }),
      /GitHub nevrátil přístupový token/,
    );
  });
});

describe("connector catalog", () => {
  let catalog;
  before(async () => {
    catalog = await import("../dist/mcp/catalog.js");
  });

  it("contains google, notion and github with unique ids", () => {
    const ids = catalog.CONNECTOR_CATALOG.map((c) => c.id).sort();
    assert.deepEqual(ids, ["github", "google", "notion", "presentation"]);
  });

  it("every entry has Czech copy, setup docs and a distinct server binary", () => {
    const suffixes = new Set();
    for (const c of catalog.CONNECTOR_CATALOG) {
      assert.ok(c.name && c.name.length > 0, `${c.id}.name must be non-empty`);
      const fields = ["tagline", "description"];
      // Lokální konektory (bez OAuth) nemají setup návod.
      if (!c.local) fields.push("setupUrl", "setupUrlLabel", "setupHelp");
      for (const field of fields) {
        assert.ok(c[field] && c[field].length > 10, `${c.id}.${field} must be non-empty Czech copy`);
      }
      if (!c.local) assert.ok(c.setupUrl.startsWith("https://"));
      assert.ok(Array.isArray(c.capabilities) && c.capabilities.length > 0);
      assert.ok(!suffixes.has(c.serverDistSuffix), "serverDistSuffix must be unique");
      suffixes.add(c.serverDistSuffix);
    }
  });

  it("matches server rows by spawned binary, including legacy google rows", () => {
    const googleBin = "/x/node_modules/@kuclab-hertz/mcp-google/dist/server.js";
    assert.equal(catalog.connectorForServerArgs([googleBin])?.id, "google");
    assert.equal(catalog.connectorForServerArgs(["/x/node_modules/@kuclab-hertz/mcp-notion/dist/server.js"])?.id, "notion");
    assert.equal(catalog.connectorForServerArgs(["/x/node_modules/@kuclab-hertz/mcp-github/dist/server.js"])?.id, "github");
    assert.equal(catalog.connectorForServerArgs(["npx", "-y", "something-else"]), undefined);
    assert.equal(catalog.connectorForServerArgs([]), undefined);
    assert.equal(catalog.connectorForServerArgs(null), undefined);
  });
});

// --- Tool registry: connect/disconnect with a fake stdio MCP server --------

const MOCK_MCP_SERVER = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  if (msg.id === undefined) continue; // notification
  if (msg.method === "initialize") respond({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "0.1.0" } });
  else if (msg.method === "tools/list") respond({ tools: [
    { name: "tool_one", description: "First mock tool", inputSchema: { type: "object", properties: {} } },
    { name: "tool_two", description: "Second mock tool", inputSchema: { type: "object", properties: {} } },
  ]});
  else if (msg.method === "tools/call") respond({ content: [{ type: "text", text: "echo:" + msg.params.name }] });
  else respond({});
}
`;

describe("mcp registry: connect/disconnect lifecycle", () => {
  let dir, db, client, registry, openDatabase, runMigrations, McpRegistry, mcpServers, newId, encryptSecret, decryptSecret;

  before(async () => {
    ({ openDatabase, newId } = await import("../dist/db/client.js"));
    ({ runMigrations } = await import("../dist/db/migrate.js"));
    ({ mcpServers } = await import("../dist/db/schema.js"));
    ({ McpRegistry } = await import("../dist/mcp/mcp-registry.js"));
    ({ encryptSecret, decryptSecret } = await import("../dist/secrets/key-encryption.js"));
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-mcp-reg-"));
    await fs.writeFile(path.join(dir, "mock-server.mjs"), MOCK_MCP_SERVER);
    ({ client, db } = openDatabase(path.join(dir, "test.db")));
    await runMigrations(client);
    registry = new McpRegistry(db, MASTER_KEY);
  });

  after(async () => {
    try { await client.close(); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function insertMockServer(name = "Mock Server") {
    const id = newId();
    await db.insert(mcpServers).values({
      id,
      agentId: null,
      name,
      transport: "stdio",
      command: process.execPath,
      argsJson: JSON.stringify([path.join(dir, "mock-server.mjs")]),
      encryptedEnv: null,
      url: null,
      enabled: true,
      createdAt: new Date(),
    });
    return id;
  }

  it("always exposes mcp__catalog, even with no servers connected", async () => {
    const defs = await registry.listToolDefinitions("agent-1");
    const catalog = defs.find((d) => d.name === "mcp__catalog");
    assert.ok(catalog, "mcp__catalog must always be present");
    assert.ok(catalog.description.length > 50);
  });

  it("registers mcp__<server>__<tool> tools after connect", async () => {
    const id = await insertMockServer();
    const defs = await registry.listToolDefinitions("agent-1");
    const names = defs.map((d) => d.name);
    assert.ok(names.includes("mcp__mock_server__tool_one"), `got: ${names.join(",")}`);
    assert.ok(names.includes("mcp__mock_server__tool_two"));
    const call = await registry.run("mcp__mock_server__tool_one", {});
    assert.equal(call.isError, false);
    assert.ok(call.summary.includes("echo:tool_one"));
    await db.delete(mcpServers).where((await import("drizzle-orm")).eq(mcpServers.id, id));
    registry.invalidate(id);
  });

  it("unregisters tools after disconnect", async () => {
    const id = await insertMockServer();
    let defs = await registry.listToolDefinitions("agent-1");
    assert.ok(defs.some((d) => d.name === "mcp__mock_server__tool_one"));
    const { eq } = await import("drizzle-orm");
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
    registry.invalidate(id);
    defs = await registry.listToolDefinitions("agent-1");
    assert.ok(!defs.some((d) => d.name.startsWith("mcp__mock_server__")), "mock tools must be gone after disconnect");
    assert.ok(defs.some((d) => d.name === "mcp__catalog"), "catalog must survive disconnect");
  });

  it("mcp__catalog reports connection status", async () => {
    const id = await insertMockServer("Notion");
    const result = await registry.run("mcp__catalog", {});
    assert.ok(result.summary.includes("google"));
    assert.ok(result.summary.includes("notion"));
    assert.ok(result.summary.includes("github"));
    const { eq } = await import("drizzle-orm");
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
    registry.invalidate(id);
  });

  it("stores server secrets encrypted, never plaintext", async () => {
    const secret = "tok-super-secret-123";
    const id = newId();
    const encrypted = encryptSecret(MASTER_KEY, JSON.stringify({ NOTION_API_KEY: secret }));
    assert.ok(!encrypted.includes(secret), "encrypted payload must not contain the plaintext token");
    await db.insert(mcpServers).values({
      id,
      agentId: null,
      name: "Secret Server",
      transport: "stdio",
      command: process.execPath,
      argsJson: JSON.stringify([path.join(dir, "mock-server.mjs")]),
      encryptedEnv: encrypted,
      url: null,
      enabled: true,
      createdAt: new Date(),
    });
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
    assert.ok(!rows[0].encryptedEnv.includes(secret));
    assert.equal(JSON.parse(decryptSecret(MASTER_KEY, rows[0].encryptedEnv)).NOTION_API_KEY, secret);
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
    registry.invalidate(id);
  });
});

// --- Route-level: full OAuth round-trip against the mock provider ---------

describe("oauth routes: one-click connect/disconnect end-to-end", () => {
  let dir, db, client, registry, app, masterKey, auth;
  let openDatabase, runMigrations, McpRegistry, mcpServers, users, encryptSecret, decryptSecret, eq;

  before(async () => {
    ({ openDatabase } = await import("../dist/db/client.js"));
    ({ runMigrations } = await import("../dist/db/migrate.js"));
    ({ mcpServers, users } = await import("../dist/db/schema.js"));
    ({ McpRegistry } = await import("../dist/mcp/mcp-registry.js"));
    ({ encryptSecret, decryptSecret } = await import("../dist/secrets/key-encryption.js"));
    ({ eq } = await import("drizzle-orm"));
    const { buildApp } = await import("../dist/app.js");
    const { createSessionToken } = await import("../dist/auth/session-tokens.js");

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-oauth-e2e-"));
    ({ client, db } = openDatabase(path.join(dir, "app.db")));
    await runMigrations(client);
    masterKey = crypto.randomBytes(32);
    registry = new McpRegistry(db, masterKey);
    // Minimal context: the real route handlers + the real tool registry,
    // without booting schedulers/channels.
    app = await buildApp({ db, masterKey, mcpRegistry: registry });

    const userId = "user-1";
    await db.insert(users).values({ id: userId, email: "qa@example.com", passwordHash: "x", role: "admin", createdAt: new Date() });
    auth = { authorization: `Bearer ${await createSessionToken(db, userId)}` };
  });

  after(async () => {
    try { await app.close(); } catch {}
    try { await client.close(); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("missing OAuth app redirects with a Czech setup hint, not a JSON error", async () => {
    const res = await app.inject({ method: "GET", url: "/api/oauth/github/start?catalogId=github", headers: auth });
    assert.equal(res.statusCode, 302);
    assert.ok(res.headers.location.startsWith("/?oauthError="), res.headers.location);
    assert.ok(decodeURIComponent(res.headers.location).includes("Client ID"), res.headers.location);
  });

  it("stores the notion OAuth app without ever exposing the secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oauth/apps",
      headers: { ...auth, "content-type": "application/json" },
      payload: { service: "notion", clientId: "notion-cid", clientSecret: "notion-secret-xyz" },
    });
    assert.equal(res.statusCode, 201);

    const list = await app.inject({ method: "GET", url: "/api/oauth/apps", headers: auth });
    const body = list.body;
    assert.ok(body.includes("notion-cid"));
    assert.ok(!body.includes("notion-secret-xyz"), "client secret must never appear in API output");
    const parsed = JSON.parse(body);
    assert.ok(parsed.apps[0].secretHint && !parsed.apps[0].secretHint.includes("notion-secret-xyz"));
  });

  let notionState = "";
  it("start redirects to the provider authorize URL with a signed state", async () => {
    const res = await app.inject({ method: "GET", url: "/api/oauth/notion/start?catalogId=notion", headers: auth });
    assert.equal(res.statusCode, 302);
    const location = new URL(res.headers.location);
    assert.equal(location.host, new URL(mockBase).host);
    assert.equal(location.searchParams.get("client_id"), "notion-cid");
    notionState = location.searchParams.get("state");
    assert.ok(notionState && notionState.length > 20);
  });

  it("callback exchanges the code, stores tokens encrypted and registers tools", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/notion/callback?code=testcode&state=${encodeURIComponent(notionState)}`,
      headers: auth,
    });
    assert.equal(res.statusCode, 302);
    assert.ok(res.headers.location.startsWith("/?connected=Notion"), res.headers.location);

    // Row exists, secret stored only in encrypted form.
    const rows = await db.select().from(mcpServers);
    const row = rows.find((r) => r.name === "Notion");
    assert.ok(row, "mcp_servers row must be created by the callback");
    assert.ok(row.encryptedEnv && !row.encryptedEnv.includes("mock-notion-token"));
    const env = JSON.parse(decryptSecret(masterKey, row.encryptedEnv));
    assert.equal(env.NOTION_API_KEY, "mock-notion-token");

    // API payloads never carry the token.
    const serversRes = await app.inject({ method: "GET", url: "/api/mcp-servers", headers: auth });
    assert.ok(!serversRes.body.includes("mock-notion-token"), "token must not leak via /api/mcp-servers");
    const intRes = await app.inject({ method: "GET", url: "/api/integrations", headers: auth });
    assert.ok(!intRes.body.includes("mock-notion-token"), "token must not leak via /api/integrations");
    const notion = JSON.parse(intRes.body).connectors.find((c) => c.id === "notion");
    assert.equal(notion.connected, true);
    assert.equal(notion.appConfigured, true);

    // Tools are registered in the agent's toolset (real MCP server binary over stdio).
    const defs = await registry.listToolDefinitions("agent-1");
    const names = defs.map((d) => d.name);
    assert.ok(names.includes("mcp__notion__notion_search"), `got: ${names.join(",")}`);
    assert.ok(names.includes("mcp__notion__notion_get_page"));
    assert.ok(names.includes("mcp__notion__notion_create_page"));
  });

  it("a connected tool actually calls the provider (mock Notion API)", async () => {
    const rows = await db.select().from(mcpServers);
    const row = rows.find((r) => r.name === "Notion");
    const env = JSON.parse(decryptSecret(masterKey, row.encryptedEnv));
    env.NOTION_API_BASE = mockBase; // test-only: point the real server binary at the mock API
    await db.update(mcpServers).set({ encryptedEnv: encryptSecret(masterKey, JSON.stringify(env)) }).where(eq(mcpServers.id, row.id));
    registry.invalidate(row.id);

    const result = await registry.run("mcp__notion__notion_search", { query: "test" });
    assert.equal(result.isError, false);
    assert.ok(result.summary.includes("Testovací stránka"), result.summary);
    assert.equal(captured.notionVersion, "2022-06-28");
  });

  it("re-connecting refreshes tokens instead of duplicating the row", async () => {
    const start = await app.inject({ method: "GET", url: "/api/oauth/notion/start?catalogId=notion", headers: auth });
    const state = new URL(start.headers.location).searchParams.get("state");
    const res = await app.inject({
      method: "GET",
      url: `/api/oauth/notion/callback?code=testcode2&state=${encodeURIComponent(state)}`,
      headers: auth,
    });
    assert.equal(res.statusCode, 302);
    const rows = await db.select().from(mcpServers);
    assert.equal(rows.filter((r) => r.name === "Notion").length, 1, "re-connect must upsert, not duplicate");
  });

  it("one-click disconnect removes the row and unregisters the tools", async () => {
    const res = await app.inject({ method: "POST", url: "/api/integrations/notion/disconnect", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).removed, 1);

    const rows = await db.select().from(mcpServers);
    assert.ok(!rows.some((r) => r.name === "Notion"), "row (and its encrypted tokens) must be deleted");

    const defs = await registry.listToolDefinitions("agent-1");
    const names = defs.map((d) => d.name);
    assert.ok(!names.some((n) => n.startsWith("mcp__notion__")), "notion tools must be unregistered");
    assert.ok(names.includes("mcp__catalog"), "catalog tool must survive");

    const intRes = await app.inject({ method: "GET", url: "/api/integrations", headers: auth });
    const notion = JSON.parse(intRes.body).connectors.find((c) => c.id === "notion");
    assert.equal(notion.connected, false);
  });

  it("updating an app with an empty secret keeps the stored secret", async () => {
    await app.inject({ method: "POST", url: "/api/oauth/apps", headers: auth, payload: { service: "github", clientId: "cid-keep", clientSecret: "very-secret-value" } });
    // Update only the Client ID; the secret field stays empty ("fill in only to change").
    await app.inject({ method: "POST", url: "/api/oauth/apps", headers: auth, payload: { service: "github", clientId: "cid-keep-2", clientSecret: "" } });
    const start = await app.inject({ method: "GET", url: "/api/oauth/github/start?catalogId=github", headers: auth });
    assert.equal(start.statusCode, 302, "start must still work with the preserved secret");
    assert.ok(!String(start.headers.location).includes("oauthError"), "must not redirect with a missing-secret error");
    const apps = JSON.parse((await app.inject({ method: "GET", url: "/api/oauth/apps", headers: auth })).body).apps;
    const gh = apps.find((a) => a.service === "github");
    assert.equal(gh.clientId, "cid-keep-2");
    assert.ok(gh.secretHint && gh.secretHint.startsWith("very") && gh.secretHint.endsWith("alue"), "secret hint must reflect the preserved secret");
  });

  it("declined consent redirects with a Czech message", async () => {
    const res = await app.inject({ method: "GET", url: "/api/oauth/notion/callback?error=access_denied", headers: auth });
    assert.equal(res.statusCode, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes("zrušeno"), res.headers.location);
  });
});
