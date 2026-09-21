/**
 * Regresní testy pro per-konektor bezpečnostní politiku:
 *  - klasifikace nástrojů (read / write / sensitive),
 *  - výchozí read-only, per-tool allow/deny,
 *  - citlivé operace vždy vyžadují approval (i v read-write),
 *  - API pro změnu politiky a zapnutí lokálního prezentačního konektoru.
 *
 * Spuštění: node --test test/mcp-policy.test.mjs  (po `npx tsc -b`)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const MASTER_KEY = crypto.randomBytes(32);

// --- Pure logic: tool-policy.ts ---------------------------------------------

describe("tool-policy: klasifikace a vynucení", () => {
  let classifyTool, enforcePolicy, parsePolicy, parseMcpOpPayload, POLICY_MODE_CZ, TOOL_CLASS_CZ;

  before(async () => {
    const mod = await import("../dist/mcp/tool-policy.js");
    ({ classifyTool, enforcePolicy, parsePolicy, parseMcpOpPayload, POLICY_MODE_CZ, TOOL_CLASS_CZ } = mod);
  });

  const ro = () => parsePolicy(null, null);
  const rw = () => parsePolicy("read-write", null);

  it("klasifikuje citlivé operace napříč konektory", () => {
    assert.equal(classifyTool("gmail_send_message"), "sensitive");
    assert.equal(classifyTool("calendar_delete_event"), "sensitive");
    assert.equal(classifyTool("sheets_write_range"), "sensitive");
    assert.equal(classifyTool("drive_delete_file"), "sensitive");
    assert.equal(classifyTool("presentation_export"), "read"); // čtení/export nic nemění
  });

  it("klasifikuje zápisy", () => {
    assert.equal(classifyTool("calendar_create_event"), "write");
    assert.equal(classifyTool("notion_create_page"), "write");
    assert.equal(classifyTool("presentation_add_slide"), "write");
    assert.equal(classifyTool("sheets_append_values"), "write");
    assert.equal(classifyTool("github_create_issue"), "write");
    assert.equal(classifyTool("gitlab_create_issue"), "write");
    assert.equal(classifyTool("todoist_create_task"), "write");
    assert.equal(classifyTool("todoist_complete_task"), "write");
    assert.equal(classifyTool("slides_create_presentation"), "write");
    assert.equal(classifyTool("slides_add_slide"), "write");
    assert.equal(classifyTool("docs_append_text"), "write");
  });

  it("klasifikuje čtení", () => {
    assert.equal(classifyTool("gmail_search_messages"), "read");
    assert.equal(classifyTool("presentation_list"), "read");
    assert.equal(classifyTool("calendar_list_events"), "read");
    assert.equal(classifyTool("drive_list_files"), "read");
    assert.equal(classifyTool("gitlab_list_projects"), "read");
    assert.equal(classifyTool("gitlab_get_file"), "read");
    assert.equal(classifyTool("todoist_list_tasks"), "read");
    assert.equal(classifyTool("weather_current"), "read");
    assert.equal(classifyTool("weather_forecast"), "read");
    assert.equal(classifyTool("rss_read_feed"), "read");
    assert.equal(classifyTool("slides_get_presentation"), "read");
    assert.equal(classifyTool("unknown_tool_xyz"), "read");
  });

  it("má české popisky bez emoji", () => {
    assert.equal(POLICY_MODE_CZ["read-only"], "Jen čtení");
    assert.equal(POLICY_MODE_CZ["read-write"], "Čtení a zápis");
    assert.equal(TOOL_CLASS_CZ.sensitive, "Citlivé");
    for (const label of Object.values({ ...POLICY_MODE_CZ, ...TOOL_CLASS_CZ })) {
      assert.ok(!/\p{Extended_Pictographic}/u.test(label), `popisek "${label}" nesmí obsahovat emoji`);
    }
  });

  it("výchozí politika je read-only s nejméně právy", () => {
    assert.deepEqual(ro(), { mode: "read-only", tools: {} });
  });

  it("čtení je povoleno vždy", () => {
    assert.equal(enforcePolicy(ro(), "gmail_search_messages").verdict, "allow");
    assert.equal(enforcePolicy(rw(), "gmail_search_messages").verdict, "allow");
  });

  it("zápis je v read-only odmítnut", () => {
    assert.equal(enforcePolicy(ro(), "presentation_add_slide").verdict, "deny-read-only");
  });

  it("zápis je v read-write povolen", () => {
    assert.equal(enforcePolicy(rw(), "presentation_add_slide").verdict, "allow");
  });

  it("explicitní allow přepíše režim read-only", () => {
    const p = { mode: "read-only", tools: { presentation_add_slide: "allow" } };
    assert.equal(enforcePolicy(p, "presentation_add_slide").verdict, "allow");
  });

  it("deny má nejvyšší prioritu, i v read-write", () => {
    const p = { mode: "read-write", tools: { presentation_add_slide: "deny" } };
    assert.equal(enforcePolicy(p, "presentation_add_slide").verdict, "deny-tool");
  });

  it("citlivá operace vyžaduje schválení i v read-write", () => {
    assert.equal(enforcePolicy(ro(), "gmail_send_message").verdict, "approval-required");
    assert.equal(enforcePolicy(rw(), "gmail_send_message").verdict, "approval-required");
  });

  it("deny citlivého nástroje znamená zákaz, ne approval", () => {
    const p = { mode: "read-write", tools: { gmail_send_message: "deny" } };
    assert.equal(enforcePolicy(p, "gmail_send_message").verdict, "deny-tool");
  });

  it("parseMcpOpPayload ověří payload approval", () => {
    const payload = { serverId: "s1", serverName: "N", toolName: "gmail_send_message", input: { a: 1 } };
    assert.deepEqual(parseMcpOpPayload(JSON.stringify(payload)), payload);
    assert.equal(parseMcpOpPayload("neplatný json"), undefined);
    assert.equal(parseMcpOpPayload(JSON.stringify({ serverId: "s1" })), undefined);
    assert.equal(parseMcpOpPayload(null), undefined);
  });
});

// --- Registry: vynucení politiky za běhu ------------------------------------

const POLICY_MOCK_SERVER = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  if (msg.id === undefined) continue;
  if (msg.method === "initialize") respond({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "policydemo", version: "0.1.0" } });
  else if (msg.method === "tools/list") respond({ tools: [
    { name: "demo_read_data", description: "Read demo data", inputSchema: { type: "object", properties: {} } },
    { name: "demo_create_item", description: "Create a demo item", inputSchema: { type: "object", properties: {} } },
    { name: "demo_send_alert", description: "Send an alert", inputSchema: { type: "object", properties: {} } },
    { name: "demo_delete_item", description: "Delete a demo item", inputSchema: { type: "object", properties: {} } },
  ]});
  else if (msg.method === "tools/call") respond({ content: [{ type: "text", text: "ran:" + msg.params.name }] });
  else respond({});
}
`;

describe("mcp registry: vynucení politiky", () => {
  let dir, db, client, registry;
  let openDatabase, runMigrations, McpRegistry, mcpServers, approvals, sessions, agents, projects, providerConfigs, users, newId, eq;
  let serverId;

  async function insertPolicyServer(overrides = {}) {
    const id = newId();
    await db.insert(mcpServers).values({
      id,
      agentId: null,
      name: "Policy Demo",
      transport: "stdio",
      command: process.execPath,
      argsJson: JSON.stringify([path.join(dir, "policy-mock.mjs")]),
      encryptedEnv: null,
      url: null,
      enabled: true,
      createdAt: new Date(),
      ...overrides,
    });
    return id;
  }

  async function execContext() {
    // approvals vyžadují platný řetězec projekt → agent → session (FK)
    const userId = newId(), pcId = newId(), projectId = newId(), agentId = newId(), sessionId = newId();
    await db.insert(users).values({ id: userId, email: `${userId}@x.test`, passwordHash: "x", role: "admin", createdAt: new Date() });
    await db.insert(providerConfigs).values({ id: pcId, userId, provider: "openai-compatible", label: "t", encryptedKey: "x", createdAt: new Date() });
    await db.insert(projects).values({ id: projectId, name: "t", createdAt: new Date() });
    await db.insert(agents).values({ id: agentId, projectId, name: "t", providerConfigId: pcId, model: "t", createdAt: new Date() });
    await db.insert(sessions).values({ id: sessionId, agentId, projectId, title: "t", createdAt: new Date(), updatedAt: new Date() });
    return { agentId, projectId, sessionId };
  }

  before(async () => {
    ({ openDatabase, newId } = await import("../dist/db/client.js"));
    ({ runMigrations } = await import("../dist/db/migrate.js"));
    ({ mcpServers, approvals, sessions, agents, projects, providerConfigs, users } = await import("../dist/db/schema.js"));
    ({ McpRegistry } = await import("../dist/mcp/mcp-registry.js"));
    ({ eq } = await import("drizzle-orm"));
    dir = await mkdtemp(path.join(os.tmpdir(), "hertz-policy-"));
    await writeFile(path.join(dir, "policy-mock.mjs"), POLICY_MOCK_SERVER);
    ({ client, db } = openDatabase(path.join(dir, "test.db")));
    await runMigrations(client);
    registry = new McpRegistry(db, MASTER_KEY);
  });

  after(async () => {
    try { await registry.shutdown(); } catch {}
    try { await client.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  it("výchozí politika je read-only: čtení projde, zápis je odmítnut", async () => {
    serverId = await insertPolicyServer();
    await registry.listToolDefinitions("agent-1");

    const read = await registry.run("mcp__policy_demo__demo_read_data", {});
    assert.equal(read.isError, false);
    assert.ok(read.summary.includes("ran:demo_read_data"));

    const write = await registry.run("mcp__policy_demo__demo_create_item", {});
    assert.equal(write.isError, true);
    assert.ok(write.summary.includes("jen pro čtení"), write.summary);
    assert.ok(!write.summary.includes("ran:demo_create_item"), "zápis se nesmí spustit");
  });

  it("popisy nástrojů nesou třídu a režim pro agenta", async () => {
    const defs = await registry.listToolDefinitions("agent-1");
    const desc = Object.fromEntries(defs.filter((d) => d.name.startsWith("mcp__policy_demo__")).map((d) => [d.name, d.description]));
    assert.ok(desc.mcp__policy_demo__demo_read_data && !desc.mcp__policy_demo__demo_read_data.includes("schválení"));
    assert.ok(desc.mcp__policy_demo__demo_create_item.includes("jen pro čtení"), desc.mcp__policy_demo__demo_create_item);
    assert.ok(desc.mcp__policy_demo__demo_send_alert.includes("schválení"), desc.mcp__policy_demo__demo_send_alert);
  });

  it("citlivá operace bez schválení se nespustí a založí approval mcp_op", async () => {
    const ctx = await execContext();
    const res = await registry.run("mcp__policy_demo__demo_send_alert", { text: "ahoj" }, ctx);
    assert.ok(res.awaitUser, "agent musí dostat awaitUser");
    assert.ok(res.summary.includes("schválení"), res.summary);
    assert.ok(!res.summary.includes("ran:demo_send_alert"), "citlivá operace se nesmí spustit");

    const rows = await db.select().from(approvals).where(eq(approvals.kind, "mcp_op"));
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0].payload);
    assert.equal(payload.toolName, "demo_send_alert");
    assert.equal(payload.serverId, serverId);
    assert.deepEqual(payload.input, { text: "ahoj" }, "approval musí nést přesný vstup");
    assert.equal(rows[0].status, "pending");

    // session metadata drží pendingApprovalId
    const sess = await db.select().from(sessions).where(eq(sessions.id, ctx.sessionId));
    const meta = JSON.parse(sess[0].metadata ?? "{}");
    assert.equal(meta.pendingApprovalId, rows[0].id);
  });

  it("per-tool deny nástroj skryje a zablokuje", async () => {
    await db.update(mcpServers).set({ policyToolsJson: JSON.stringify({ demo_read_data: "deny" }) }).where(eq(mcpServers.id, serverId));
    registry.invalidate(serverId);
    const defs = await registry.listToolDefinitions("agent-1");
    assert.ok(!defs.some((d) => d.name === "mcp__policy_demo__demo_read_data"), "denied nástroj nesmí být v seznamu");

    const res = await registry.run("mcp__policy_demo__demo_read_data", {});
    assert.equal(res.isError, true);
    assert.ok(res.summary.includes("zakázán"), res.summary);
    assert.ok(!res.summary.includes("ran:demo_read_data"));
  });

  it("explicitní allow přepíše read-only pro daný nástroj", async () => {
    await db.update(mcpServers).set({ policyToolsJson: JSON.stringify({ demo_create_item: "allow" }) }).where(eq(mcpServers.id, serverId));
    registry.invalidate(serverId);
    await registry.listToolDefinitions("agent-1");
    const res = await registry.run("mcp__policy_demo__demo_create_item", {});
    assert.equal(res.isError, false);
    assert.ok(res.summary.includes("ran:demo_create_item"));
  });

  it("read-write povolí zápis, ale citlivá operace dál vyžaduje schválení", async () => {
    await db.update(mcpServers).set({ policyMode: "read-write", policyToolsJson: null }).where(eq(mcpServers.id, serverId));
    registry.invalidate(serverId);
    await registry.listToolDefinitions("agent-1");

    const write = await registry.run("mcp__policy_demo__demo_create_item", {});
    assert.equal(write.isError, false);

    const ctx = await execContext();
    const sensitive = await registry.run("mcp__policy_demo__demo_delete_item", {}, ctx);
    assert.ok(sensitive.awaitUser, "citlivá operace vyžaduje schválení i v read-write");
    assert.ok(!sensitive.summary.includes("ran:demo_delete_item"), "citlivá operace se nesmí spustit ani v read-write");
  });

  it("schválená operace se vykoná přesně jednou přes executeApprovedOp", async () => {
    const pending = (await db.select().from(approvals).where(eq(approvals.kind, "mcp_op"))).at(-1);
    assert.ok(pending, "musí existovat pending mcp_op approval");
    const payload = JSON.parse(pending.payload);
    const result = await registry.executeApprovedOp(payload.serverId, payload.toolName, payload.input);
    assert.equal(result.isError, false);
    assert.ok(result.summary.includes("ran:demo_delete_item"), result.summary);
  });
});

// --- Routes: policy API + enable lokálního konektoru -------------------------

describe("integrations routes: politika a lokální konektor", () => {
  let dir, db, client, registry, app, auth;
  let openDatabase, runMigrations, McpRegistry, mcpServers, users, newId, eq;

  before(async () => {
    ({ openDatabase, newId } = await import("../dist/db/client.js"));
    ({ runMigrations } = await import("../dist/db/migrate.js"));
    ({ mcpServers, users } = await import("../dist/db/schema.js"));
    ({ McpRegistry } = await import("../dist/mcp/mcp-registry.js"));
    ({ eq } = await import("drizzle-orm"));
    const { buildApp } = await import("../dist/app.js");
    const { createSessionToken } = await import("../dist/auth/session-tokens.js");

    dir = await mkdtemp(path.join(os.tmpdir(), "hertz-policy-routes-"));
    ({ client, db } = openDatabase(path.join(dir, "app.db")));
    await runMigrations(client);
    registry = new McpRegistry(db, MASTER_KEY);
    app = await buildApp({ db, masterKey: MASTER_KEY, mcpRegistry: registry });

    const userId = "user-1";
    await db.insert(users).values({ id: userId, email: "qa@example.com", passwordHash: "x", role: "admin", createdAt: new Date() });
    auth = { authorization: `Bearer ${await createSessionToken(db, userId)}` };
  });

  after(async () => {
    await registry.shutdown();
    try { await app.close(); } catch {}
    try { await client.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  const json = { ...{}, "content-type": "application/json" };

  it("enable zapne lokální prezentační konektor s výchozí politikou read-only", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/integrations/presentation/enable",
      headers: { ...auth, ...json }, payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.ok);
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.id, body.serverId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].policyMode, "read-only");

    const list = await app.inject({ method: "GET", url: "/api/integrations", headers: auth });
    const connectors = JSON.parse(list.body).connectors;
    const presentation = connectors.find((c) => c.id === "presentation");
    assert.ok(presentation);
    assert.equal(presentation.local, true);
    assert.equal(presentation.connected, true);
    assert.equal(presentation.servers[0].policy.mode, "read-only");
    assert.ok(presentation.servers[0].policy.tools.some((t) => t.name === "presentation_create"));
  });

  it("policy endpoint změní režim a per-tool deny", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/integrations/presentation/policy",
      headers: { ...auth, ...json }, payload: { mode: "read-write", tools: { presentation_export: "deny" } },
    });
    assert.equal(res.statusCode, 200);

    const list = await app.inject({ method: "GET", url: "/api/integrations", headers: auth });
    const presentation = JSON.parse(list.body).connectors.find((c) => c.id === "presentation");
    assert.equal(presentation.servers[0].policy.mode, "read-write");
    const exp = presentation.servers[0].policy.tools.find((t) => t.name === "presentation_export");
    assert.ok(exp && !exp.allowed, "deny musí být vidět v API");
  });

  it("policy endpoint odmítne neplatný vstup", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/integrations/presentation/policy",
      headers: { ...auth, ...json }, payload: { mode: "root" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("policy endpoint vrátí 404 pro nepřipojený konektor", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/integrations/notion/policy",
      headers: { ...auth, ...json }, payload: { mode: "read-write" },
    });
    assert.equal(res.statusCode, 404);
  });

  it("disconnect odstraní i lokální konektor", async () => {
    const res = await app.inject({ method: "POST", url: "/api/integrations/presentation/disconnect", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.ok(JSON.parse(res.body).removed >= 1);
    const rows = await db.select().from(mcpServers);
    assert.ok(!rows.some((r) => (JSON.parse(r.argsJson ?? "[]")[0] ?? "").includes("mcp-presentation")));
  });
});
