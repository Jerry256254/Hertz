import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { users } from "../dist/db/schema.js";
import { createSessionToken } from "../dist/auth/session-tokens.js";
import { registerAuthPlugin } from "../dist/auth/plugin.js";
import { registerProviderRoutes } from "../dist/routes/providers.js";
import { registerAgentRoutes } from "../dist/routes/agents.js";

/**
 * Route-level testy českých validačních chyb:
 * POST /api/providers s prázdným labelem a PATCH /api/agents/:id s prázdným
 * modelem musí vrátit českou hlášku — nikdy surový Zod JSON.
 */

let app;
let client;
let token;

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-czech-err-"));
  const opened = openDatabase(path.join(dir, "test.db"));
  client = opened.client;
  const db = opened.db;
  await runMigrations(client);
  const now = new Date();
  await db.insert(users).values({ id: "user-1", email: "u@x.y", passwordHash: "h", role: "admin", createdAt: now });
  token = await createSessionToken(db, "user-1");

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
  registerProviderRoutes(app, ctxStub);
  registerAgentRoutes(app, ctxStub);
  await app.ready();
}

const auth = () => ({ authorization: `Bearer ${token}` });
const NO_ZOD_JSON = (body) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  assert.ok(!raw.includes('[{"code"'), `surový Zod JSON v odpovědi: ${raw}`);
  assert.ok(!raw.includes("too_small"), `anglický Zod kód v odpovědi: ${raw}`);
};

describe("české validační chyby v routách", () => {
  before(seed);
  after(() => client.close());

  it("POST /api/providers s prázdným labelem → česká hláška", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: { ...auth(), "content-type": "application/json" },
      payload: { provider: "openai", label: "   ", apiKey: "k" },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error.includes("název"), `chybí český popisek: ${body.error}`);
    NO_ZOD_JSON(body);
  });

  it("POST /api/providers se špatnou URL → česká hláška", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: { ...auth(), "content-type": "application/json" },
      payload: { provider: "openai-compatible", label: "x", apiKey: "k", baseUrl: "neni-adresa" },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error.includes("platná adresa"), `chybí česká hláška: ${body.error}`);
    NO_ZOD_JSON(body);
  });

  it("PATCH /api/agents/:id s prázdným modelem → „Vyber nebo zadej model.\"", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agents/agent-neexistuje",
      headers: { ...auth(), "content-type": "application/json" },
      payload: { model: "" },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, "Vyber nebo zadej model.");
    NO_ZOD_JSON(body);
  });
});
