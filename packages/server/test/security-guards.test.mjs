import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { agents, approvals, projectMembers, providerConfigs, projects, sessions, users } from "../dist/db/schema.js";
import { createSessionToken } from "../dist/auth/session-tokens.js";
import { registerAuthPlugin } from "../dist/auth/plugin.js";
import { registerApprovalRoutes } from "../dist/routes/approvals.js";
import { registerProviderRoutes } from "../dist/routes/providers.js";
import { registerAgentRoutes } from "../dist/routes/agents.js";
import { registerSessionRoutes } from "../dist/routes/sessions.js";

/**
 * Route-level regression tests for the authorization guards:
 * a project member must not reach another project's approvals/agents/sessions,
 * deleting a provider that agents still reference must fail loudly, and a
 * message to an archived chat must 410 instead of being silently dropped.
 */

let app;
let db;
let client;
let tokenAdmin;
let tokenMember;

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-secguards-"));
  const opened = openDatabase(path.join(dir, "test.db"));
  client = opened.client;
  db = opened.db;
  await runMigrations(client);
  const now = new Date();

  await db.insert(users).values([
    { id: "admin-1", email: "admin@x.y", passwordHash: "h", role: "admin", createdAt: now },
    { id: "member-1", email: "member@x.y", passwordHash: "h", role: "user", createdAt: now },
  ]);
  await db.insert(projects).values([
    { id: "proj-a", name: "A", createdAt: now },
    { id: "proj-b", name: "B", createdAt: now },
  ]);
  // member-1 belongs to proj-b only.
  await db.insert(projectMembers).values({ id: "pm-1", projectId: "proj-b", userId: "member-1", createdAt: now });

  await db.insert(providerConfigs).values([
    { id: "pc-admin", userId: "admin-1", provider: "openai", label: "admin-pc", encryptedKey: "k", createdAt: now },
    { id: "pc-member", userId: "member-1", provider: "openai", label: "member-pc", encryptedKey: "k", createdAt: now },
    { id: "pc-free", userId: "admin-1", provider: "openai", label: "unused", encryptedKey: "k", createdAt: now },
  ]);
  await db.insert(agents).values([
    { id: "agent-a", projectId: "proj-a", name: "A", providerConfigId: "pc-admin", model: "m", createdAt: now },
    { id: "agent-b", projectId: "proj-b", name: "B", providerConfigId: "pc-member", model: "m", createdAt: now },
  ]);
  await db.insert(sessions).values([
    { id: "sess-a", agentId: "agent-a", projectId: "proj-a", title: "t", status: "active", createdAt: now, updatedAt: now },
    { id: "sess-b", agentId: "agent-b", projectId: "proj-b", title: "t", status: "active", createdAt: now, updatedAt: now },
    { id: "sess-archived", agentId: "agent-b", projectId: "proj-b", title: "t", status: "archived", createdAt: now, updatedAt: now },
  ]);
  await db.insert(approvals).values({
    id: "appr-a",
    projectId: "proj-a",
    agentId: "agent-a",
    sessionId: "sess-a",
    summary: "do a thing",
    status: "pending",
    createdAt: now,
  });

  tokenAdmin = await createSessionToken(db, "admin-1");
  tokenMember = await createSessionToken(db, "member-1");

  const ctxStub = {
    db,
    masterKey: "x".repeat(64),
    audit: { record: async () => {} },
    agentLoop: { appendInbound: async () => ({}), isRunning: () => false },
    queue: { enqueue: async () => "job-1" },
  };
  app = Fastify();
  await app.register(fastifyCookie);
  registerAuthPlugin(app, db);
  registerApprovalRoutes(app, ctxStub);
  registerProviderRoutes(app, ctxStub);
  registerAgentRoutes(app, ctxStub);
  registerSessionRoutes(app, ctxStub);
  await app.ready();
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

describe("security guards", () => {
  before(seed);

  it("member cannot decide another project's approval (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/appr-a/decision",
      headers: auth(tokenMember),
      payload: { decision: "approved" },
    });
    assert.equal(res.statusCode, 403);
  });

  it("admin can decide the approval (200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/appr-a/decision",
      headers: auth(tokenAdmin),
      payload: { decision: "rejected" },
    });
    assert.equal(res.statusCode, 200);
  });

  it("provider in use cannot be deleted (409)", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/providers/pc-admin", headers: auth(tokenAdmin) });
    assert.equal(res.statusCode, 409);
  });

  it("unused provider can be deleted (204)", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/providers/pc-free", headers: auth(tokenAdmin) });
    assert.equal(res.statusCode, 204);
  });

  it("deleting someone else's provider is 404 (no leak)", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/providers/pc-admin", headers: auth(tokenMember) });
    assert.equal(res.statusCode, 404);
  });

  it("member cannot assign another user's provider to an agent (403)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agents/agent-b",
      headers: auth(tokenMember),
      payload: { providerConfigId: "pc-admin" },
    });
    assert.equal(res.statusCode, 403);
  });

  it("member can assign their own provider (200)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agents/agent-b",
      headers: auth(tokenMember),
      payload: { providerConfigId: "pc-member" },
    });
    assert.equal(res.statusCode, 200);
  });

  it("ensure-chat rejects cross-project (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/agent-b/ensure-chat",
      headers: auth(tokenMember),
      payload: { projectId: "proj-a" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("session creation rejects cross-project (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/agent-b/sessions",
      headers: auth(tokenMember),
      payload: { projectId: "proj-a" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("message to archived session is 410, not silently dropped", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-archived/messages",
      headers: auth(tokenMember),
      payload: { text: "hello?" },
    });
    assert.equal(res.statusCode, 410);
  });
});
