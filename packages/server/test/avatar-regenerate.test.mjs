/**
 * Regression tests for the avatar regeneration end-to-end flow
 * (the "avatar stayed the same" bug):
 *
 *  1. The `regenerate_avatar` tool mints a NEW spec (different seed),
 *     persists it to the DB, and reports success ONLY when the write really
 *     landed (re-read verification) — the agent must never again claim
 *     "Hotovo" while the avatar is unchanged.
 *  2. GET /api/agents/:id/avatar.svg returns the NEW SVG after regeneration,
 *     with an ETag tied to the stored spec: unchanged → cheap 304 on
 *     revalidation, changed spec → new bytes, so a browser cache can never
 *     serve the old artwork as current.
 *
 * Runs against a real in-memory libsql database (hand-written bootstrap SQL
 * from migrate.ts) and the real Fastify route, so the SQL and the HTTP
 * caching headers are covered too.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import Fastify from "fastify";

import { runMigrations } from "../dist/db/migrate.js";
import * as schema from "../dist/db/schema.js";
import { newId } from "../dist/db/client.js";
import { avatarSvgForAgent, parseAvatarSpec } from "../dist/agents/avatar.js";
import { createOnboardingTools } from "../dist/tools/onboarding-tools.js";
import { registerAgentRoutes } from "../dist/routes/agents.js";

const now = () => new Date();

async function makeDb() {
  const client = createClient({ url: ":memory:" });
  await runMigrations(client);
  return { client, db: drizzle(client, { schema }) };
}

/** Minimal FK chain: user → providerConfig → project → agent (with a known avatar). */
async function seedAgent(db) {
  const userId = newId();
  await db
    .insert(schema.users)
    .values({ id: userId, email: `${userId}@t.cz`, passwordHash: "x", role: "admin", createdAt: now() });
  const pcId = newId();
  await db.insert(schema.providerConfigs).values({
    id: pcId,
    userId,
    provider: "anthropic",
    label: "T",
    encryptedKey: "x",
    defaultModel: "m",
    createdAt: now(),
  });
  const projectId = newId();
  await db.insert(schema.projects).values({ id: projectId, name: "Osobní", createdAt: now() });
  const agentId = newId();
  await db.insert(schema.agents).values({
    id: agentId,
    projectId,
    providerConfigId: pcId,
    name: "Orion",
    model: "m",
    avatar: JSON.stringify({ version: 1, kind: "generative", seed: "orion:0123456789ab" }),
    createdAt: now(),
  });
  return { agentId, projectId };
}

const toolCtx = (agentId) => ({
  actor: { actorId: agentId, actorType: "agent", sessionId: "sess-1", projectId: "proj-1" },
});

async function storedAvatar(db, agentId) {
  const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  return rows[0]?.avatar ?? null;
}

describe("regenerate_avatar tool", () => {
  it("mints a new spec, persists it, and succeeds only when the write landed", async () => {
    const { client, db } = await makeDb();
    try {
      const { agentId } = await seedAgent(db);
      const [, regen] = createOnboardingTools(db);
      assert.equal(regen.name, "regenerate_avatar");

      const before = await storedAvatar(db, agentId);
      const res = await regen.execute({}, toolCtx(agentId));
      assert.ok(!res.isError, `tool must succeed, got: ${res.summary}`);

      const after = await storedAvatar(db, agentId);
      const beforeSpec = parseAvatarSpec(before);
      const afterSpec = parseAvatarSpec(after);
      assert.ok(afterSpec, "stored avatar must be a valid generative spec");
      assert.ok(beforeSpec, "seed avatar must be a valid generative spec");
      assert.notEqual(afterSpec.seed, beforeSpec.seed, "regeneration must change the seed");
      assert.equal(after, JSON.stringify(afterSpec), "the minted spec must be stored verbatim");
    } finally {
      client.close();
    }
  });

  it("reports an error (not fake success) when the agent row does not exist", async () => {
    const { client, db } = await makeDb();
    try {
      const [, regen] = createOnboardingTools(db);
      const res = await regen.execute({}, toolCtx("ghost-agent"));
      assert.ok(res.isError, "missing agent must be an error, never a silent success");
    } finally {
      client.close();
    }
  });
});

describe("GET /api/agents/:id/avatar.svg", () => {
  it("serves the new SVG after regeneration, with a changed ETag; 304 on revalidation", async () => {
    const { client, db } = await makeDb();
    const app = Fastify();
    app.addHook("preHandler", (req, _reply, done) => {
      req.user = { id: "admin-1", role: "admin" };
      done();
    });
    registerAgentRoutes(app, { db });
    await app.ready();
    try {
      const { agentId } = await seedAgent(db);
      const url = `/api/agents/${agentId}/avatar.svg`;

      const first = await app.inject({ method: "GET", url });
      assert.equal(first.statusCode, 200);
      assert.match(first.headers["content-type"] ?? "", /image\/svg\+xml/);
      assert.equal(first.headers["cache-control"], "no-cache", "must revalidate, never serve stale blindly");
      const etag1 = first.headers.etag;
      assert.ok(etag1, "must send an ETag");

      // Revalidation while unchanged → 304, no body.
      const notModified = await app.inject({ method: "GET", url, headers: { "if-none-match": etag1 } });
      assert.equal(notModified.statusCode, 304);

      // Regenerate through the real tool, then the endpoint must serve new bytes.
      const [, regen] = createOnboardingTools(db);
      const res = await regen.execute({}, toolCtx(agentId));
      assert.ok(!res.isError, `regeneration must succeed, got: ${res.summary}`);

      const second = await app.inject({ method: "GET", url });
      assert.equal(second.statusCode, 200);
      assert.notEqual(second.body, first.body, "endpoint must return the NEW svg after regeneration");
      assert.notEqual(second.headers.etag, etag1, "ETag must change with the avatar");

      // The stale ETag revalidates to fresh content; the fresh one to 304.
      const stale = await app.inject({ method: "GET", url, headers: { "if-none-match": etag1 } });
      assert.equal(stale.statusCode, 200);
      assert.equal(stale.body, second.body);
      const fresh = await app.inject({
        method: "GET",
        url,
        headers: { "if-none-match": second.headers.etag },
      });
      assert.equal(fresh.statusCode, 304);

      // Sanity: the body is exactly what the pure renderer produces for the stored spec.
      const stored = await storedAvatar(db, agentId);
      assert.equal(second.body, avatarSvgForAgent(stored, agentId));
    } finally {
      await app.close();
      client.close();
    }
  });

  it("POST /api/agents/:id/avatar/regenerate re-rolls the avatar and the endpoint serves it", async () => {
    const { client, db } = await makeDb();
    const app = Fastify();
    app.addHook("preHandler", (req, _reply, done) => {
      req.user = { id: "admin-1", role: "admin" };
      done();
    });
    registerAgentRoutes(app, { db });
    await app.ready();
    try {
      const { agentId } = await seedAgent(db);
      const before = await app.inject({ method: "GET", url: `/api/agents/${agentId}/avatar.svg` });
      assert.equal(before.statusCode, 200);

      const regen = await app.inject({ method: "POST", url: `/api/agents/${agentId}/avatar/regenerate` });
      assert.equal(regen.statusCode, 200, `regenerate must succeed, got: ${regen.body}`);

      const after = await app.inject({ method: "GET", url: `/api/agents/${agentId}/avatar.svg` });
      assert.equal(after.statusCode, 200);
      assert.notEqual(after.body, before.body, "endpoint must serve the new svg after UI-driven regeneration");
      assert.notEqual(after.headers.etag, before.headers.etag, "ETag must change");

      const stored = await storedAvatar(db, agentId);
      const spec = parseAvatarSpec(stored);
      assert.ok(spec && spec.seed !== "orion:0123456789ab", "stored seed must differ from the original");
    } finally {
      await app.close();
      client.close();
    }
  });

  it("404s unknown agents", async () => {
    const { client, db } = await makeDb();
    const app = Fastify();
    app.addHook("preHandler", (req, _reply, done) => {
      req.user = { id: "admin-1", role: "admin" };
      done();
    });
    registerAgentRoutes(app, { db });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/api/agents/nope/avatar.svg" });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
      client.close();
    }
  });
});
