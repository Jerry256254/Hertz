import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import Fastify from "fastify";
import { openDatabase } from "../dist/db/client.js";
import { runMigrations } from "../dist/db/migrate.js";
import { mcpServers } from "../dist/db/schema.js";
import { decryptSecret } from "../dist/secrets/key-encryption.js";
import {
  registerOAuthRoutes,
  resolveAppCredentials,
  runDevicePolling,
  pruneDeviceSessions,
  deviceSessions,
} from "../dist/routes/oauth.js";

/**
 * Routové regresní testy OAuth 2.0 Device flow (bod 1–5 auditu
 * „kód se mi neukazuje"): POST /api/oauth/google/device/start a
 * GET /api/oauth/google/device/status proti reálné Fastify aplikaci,
 * reálné DB (libsql, migrace) a mock Google HTTP serveru.
 *
 * Google endpointy se přepínají přes env (HERTZ_OAUTH_GOOGLE_DEVICE_CODE_URL /
 * HERTZ_OAUTH_GOOGLE_TOKEN_URL) — čte se při každém volání, takže jde
 * přepínat i uprostřed testu. Pozadí pollingu (runDevicePolling) běží se
 * skutečnými časovači: mock vrací interval=1 s, expires_in=4 s, takže se
 * každá session sama ukončí do ~4 s a testy nevisí.
 */

const DEVICE_CODE_PATH = "/device/code";
const TOKEN_PATH = "/token";
const GUIDE_URL = "https://console.cloud.google.com/apis/credentials";

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** Zachycená volání device/code (params jako prostý objekt). */
let deviceCodeCalls = [];
let deviceCodeHandler = defaultDeviceCodeHandler;
let tokenHandler = defaultTokenHandler;

function defaultDeviceCodeHandler(req, res, params) {
  deviceCodeCalls.push(Object.fromEntries(params.entries()));
  json(res, 200, {
    device_code: "DEV-CODE-1",
    user_code: "ABCD-EFGH",
    verification_url: "https://www.google.com/device",
    verification_uri_complete: "https://www.google.com/device?user_code=ABCD-EFGH",
    expires_in: 4,
    interval: 1,
  });
}

function defaultTokenHandler(req, res) {
  json(res, 400, { error: "authorization_pending" });
}

const googleMock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    const params = new URLSearchParams(raw);
    if (req.method === "POST" && req.url === DEVICE_CODE_PATH) deviceCodeHandler(req, res, params);
    else if (req.method === "POST" && req.url === TOKEN_PATH) tokenHandler(req, res, params);
    else {
      res.writeHead(404);
      res.end();
    }
  });
});

let app;
let ctx;
let client;
const savedEnv = {};

function setGoogleEnv(port) {
  process.env.HERTZ_OAUTH_GOOGLE_DEVICE_CODE_URL = `http://127.0.0.1:${port}${DEVICE_CODE_PATH}`;
  process.env.HERTZ_OAUTH_GOOGLE_TOKEN_URL = `http://127.0.0.1:${port}${TOKEN_PATH}`;
}

async function seedCreds(clientId = "CID-1", clientSecret = "SEC-1") {
  const r = await app.inject({
    method: "POST",
    url: "/api/oauth/apps",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ service: "google", clientId, clientSecret }),
  });
  assert.equal(r.statusCode, 201, `seed creds failed: ${r.body}`);
}

async function clearCreds() {
  const r = await app.inject({ method: "DELETE", url: "/api/oauth/apps/google" });
  assert.equal(r.statusCode, 204, `clear creds failed: ${r.body}`);
}

/** Čeká, dokud fn() nesplní predikát (nebo vyprší timeout). */
async function waitFor(fn, pred, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timeout při čekání na podmínku");
    await new Promise((r) => setTimeout(r, 150));
  }
}

function assertNoStacktrace(raw, context) {
  assert.ok(!raw.includes("\n    at "), `${context}: odpověď obsahuje stacktrace`);
  const body = JSON.parse(raw);
  assert.ok(!("stack" in body), `${context}: odpověď obsahuje klíč stack`);
  return body;
}

async function getStatus(sessionId) {
  const r = await app.inject({ method: "GET", url: `/api/oauth/google/device/status?session=${sessionId}` });
  return { statusCode: r.statusCode, body: r.json(), raw: r.body };
}

before(async () => {
  await new Promise((resolve) => googleMock.listen(0, "127.0.0.1", resolve));
  const port = googleMock.address().port;
  for (const k of [
    "HERTZ_OAUTH_GOOGLE_DEVICE_CODE_URL",
    "HERTZ_OAUTH_GOOGLE_TOKEN_URL",
    "HERTZ_OAUTH_GOOGLE_CLIENT_ID",
    "HERTZ_OAUTH_GOOGLE_CLIENT_SECRET",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  setGoogleEnv(port);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hertz-oauth-device-"));
  const opened = openDatabase(path.join(dir, "test.db"));
  client = opened.client;
  await runMigrations(client);
  const masterKey = crypto.randomBytes(32);
  ctx = { db: opened.db, masterKey, mcpRegistry: { invalidate() {} } };

  app = Fastify({ logger: false });
  app.addHook("onRequest", (req, reply, done) => {
    req.user = { id: "user-1", role: "admin" };
    done();
  });
  registerOAuthRoutes(app, ctx);
  await app.ready();
  await seedCreds();
});

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  deviceCodeHandler = defaultDeviceCodeHandler;
  tokenHandler = defaultTokenHandler;
  await app.close();
  client.close();
  googleMock.close();
});

describe("bod 1: POST /device/start bez těla z frontendu", () => {
  it("bez body a bez content-type nespadne a vrátí kód", async () => {
    // Přesně takhle to posílá webové UI: api.post(path) bez body.
    const res = await app.inject({ method: "POST", url: "/api/oauth/google/device/start" });
    assert.equal(res.statusCode, 200, `očekáváno 200, tělo: ${res.body}`);
    const body = res.json();
    assert.equal(body.user_code, "ABCD-EFGH");
    assert.ok(body.verification_url.includes("google.com/device"));
    assert.equal(body.expires_in, 4);
    assert.ok(typeof body.device_session_id === "string" && body.device_session_id.length > 0);
    // Session je čerstvě pending — UI má co ukázat.
    const s = deviceSessions.get(body.device_session_id);
    assert.ok(s, "session musí existovat v mapě");
    assert.equal(s.status, "pending");
  });

  it("s prázdným JSON {} projde a použije výchozí catalogId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oauth/google/device/start",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user_code, "ABCD-EFGH");
  });

  it("s JSON tělem {catalogId} se předá scope pro danou službu", async () => {
    const before = deviceCodeCalls.length;
    const res = await app.inject({
      method: "POST",
      url: "/api/oauth/google/device/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ catalogId: "gmail" }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(deviceCodeCalls.length, before + 1);
    assert.match(deviceCodeCalls.at(-1).scope, /gmail/);
  });

  it("poškozené JSON → 400 strukturovaná česká chyba (žádný anglický Fastify formát)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/oauth/google/device/start",
      headers: { "content-type": "application/json" },
      payload: "{toto-neni-json",
    });
    assert.equal(res.statusCode, 400);
    const body = assertNoStacktrace(res.body, "bad_request");
    assert.equal(body.code, "bad_request");
    assert.match(body.error, /se nepodařilo přečíst/);
  });
});

describe("bod 3: čerstvá session se nesmí okamžitě překlopit do error", () => {
  it("první dotaz na status po startu vrátí pending, i když token endpoint hned zamítne", async () => {
    tokenHandler = (req, res) => json(res, 400, { error: "access_denied" });
    try {
      const start = await app.inject({ method: "POST", url: "/api/oauth/google/device/start" });
      assert.equal(start.statusCode, 200);
      const { device_session_id } = start.json();

      // První poll běží až po intervalu (1 s) — teď musí být pending.
      const first = await getStatus(device_session_id);
      assert.equal(first.statusCode, 200);
      assert.equal(first.body.status, "pending");

      // Po doběhu prvního pollu se session překlopí na denied (ne error).
      const fin = await waitFor(
        async () => (await getStatus(device_session_id)).body,
        (b) => b.status !== "pending",
      );
      assert.equal(fin.status, "denied");
      assert.equal(fin.code, "access_denied");
      assert.match(fin.message, /zamítli/);
    } finally {
      tokenHandler = defaultTokenHandler;
    }
  });

  it("runDevicePolling happy path → connected a tokeny se uloží do mcp_servers", async () => {
    tokenHandler = (req, res) =>
      json(res, 200, { access_token: "AT-1", refresh_token: "REF-1", expires_in: 3600, scope: "x" });
    try {
      const session = {
        id: "sess-unit-ok",
        userId: "user-1",
        agentId: null,
        catalogId: "google",
        clientId: "CID-9",
        clientSecret: "SEC-9",
        deviceCode: "DEV-UNIT",
        userCode: "WXYZ-QWER",
        verificationUrl: "https://www.google.com/device",
        intervalSec: 1,
        expiresInSec: 30,
        status: "pending",
      };
      await runDevicePolling(ctx, session);
      assert.equal(session.status, "connected");
      assert.ok(typeof session.finishedAt === "number");
      const rows = await ctx.db.select().from(mcpServers);
      const row = rows.find((r) => {
        try {
          return JSON.parse(decryptSecret(ctx.masterKey, r.encryptedEnv)).GOOGLE_REFRESH_TOKEN === "REF-1";
        } catch {
          return false;
        }
      });
      assert.ok(row, "tokeny musí být uložené v mcp_servers");
      const env = JSON.parse(decryptSecret(ctx.masterKey, row.encryptedEnv));
      assert.equal(env.GOOGLE_ACCESS_TOKEN, "AT-1");
      assert.equal(env.GOOGLE_CLIENT_ID, "CID-9");
    } finally {
      tokenHandler = defaultTokenHandler;
    }
  });

  it("runDevicePolling: access_denied → denied s českou zprávou (ne error)", async () => {
    tokenHandler = (req, res) => json(res, 400, { error: "access_denied" });
    try {
      const session = {
        id: "sess-unit-denied",
        userId: "user-1",
        agentId: null,
        catalogId: "google",
        clientId: "CID-9",
        clientSecret: "SEC-9",
        deviceCode: "DEV-UNIT",
        userCode: "WXYZ-QWER",
        verificationUrl: "https://www.google.com/device",
        intervalSec: 1,
        expiresInSec: 30,
        status: "pending",
      };
      await runDevicePolling(ctx, session);
      assert.equal(session.status, "denied");
      assert.equal(session.code, "access_denied");
      assert.match(session.message, /zamítli/);
    } finally {
      tokenHandler = defaultTokenHandler;
    }
  });
});

describe("bod 5: každá cesta selhání startu vrací strukturovanou českou chybu", () => {
  it("bez údajů → 400 {code, error česky, guideUrl}", async () => {
    await clearCreds();
    try {
      const res = await app.inject({ method: "POST", url: "/api/oauth/google/device/start" });
      assert.equal(res.statusCode, 400);
      const body = assertNoStacktrace(res.body, "missing_client_id");
      assert.equal(body.code, "missing_client_id");
      assert.match(body.error, /Client ID TV klienta/);
      assert.equal(body.guideUrl, GUIDE_URL);
    } finally {
      await seedCreds();
    }
  });

  it("Google odmítne klienta (invalid_client) → 502 invalid_client_type s návodem", async () => {
    deviceCodeHandler = (req, res) =>
      json(res, 400, { error: "invalid_client", error_description: "The OAuth client was not found." });
    try {
      const res = await app.inject({ method: "POST", url: "/api/oauth/google/device/start" });
      assert.equal(res.statusCode, 502);
      const body = assertNoStacktrace(res.body, "invalid_client_type");
      assert.equal(body.code, "invalid_client_type");
      assert.match(body.error, /TVs and Limited Input devices/);
      assert.equal(body.guideUrl, GUIDE_URL);
      assert.ok(!res.body.includes("CID-1"), "odpověď nesmí nést client_id");
    } finally {
      deviceCodeHandler = defaultDeviceCodeHandler;
    }
  });

  it("nedostupný Google → 502 network_error s českou zprávou", async () => {
    const real = process.env.HERTZ_OAUTH_GOOGLE_DEVICE_CODE_URL;
    process.env.HERTZ_OAUTH_GOOGLE_DEVICE_CODE_URL = "http://127.0.0.1:1/device/code";
    try {
      const res = await app.inject({ method: "POST", url: "/api/oauth/google/device/start" });
      assert.equal(res.statusCode, 502);
      const body = assertNoStacktrace(res.body, "network_error");
      assert.equal(body.code, "network_error");
      assert.match(body.error, /nedostal ke Googlu/);
      assert.ok(!body.guideUrl, "u network_error se nenabízí návod");
    } finally {
      process.env.HERTZ_OAUTH_GOOGLE_DEVICE_CODE_URL = real;
    }
  });

  it("pád DB při načítání údajů → 500 provider_error česky, žádný stacktrace", async () => {
    const brokenCtx = {
      db: {
        select() {
          throw new Error("db down");
        },
      },
      masterKey: ctx.masterKey,
      mcpRegistry: { invalidate() {} },
    };
    const app2 = Fastify({ logger: false });
    app2.addHook("onRequest", (req, reply, done) => {
      req.user = { id: "user-1", role: "admin" };
      done();
    });
    registerOAuthRoutes(app2, brokenCtx);
    await app2.ready();
    try {
      const res = await app2.inject({ method: "POST", url: "/api/oauth/google/device/start" });
      assert.equal(res.statusCode, 500);
      const body = assertNoStacktrace(res.body, "db down");
      assert.equal(body.code, "provider_error");
      assert.match(body.error, /se nepodařilo načíst/);
      assert.ok(!res.body.includes("db down"), "vnitřní chyba se nesmí propadnout ven");
    } finally {
      await app2.close();
    }
  });

  it("status neexistující session → 404 s code", async () => {
    const { statusCode, body } = await getStatus("tato-session-neexistuje");
    assert.equal(statusCode, 404);
    assert.equal(body.code, "session_not_found");
    assert.match(body.error, /neexistuje nebo vypršela/);
  });
});

describe("bod 2: resolveAppCredentials po uložení přes POST /oauth/apps", () => {
  it("vrátí právě uložené údaje (shoda klíče služby google)", async () => {
    const creds = await resolveAppCredentials(ctx, "google");
    assert.deepEqual(creds, { clientId: "CID-1", clientSecret: "SEC-1" });
  });

  it("start použije uložené client_id při volání Googlu", async () => {
    const before = deviceCodeCalls.length;
    const res = await app.inject({ method: "POST", url: "/api/oauth/google/device/start" });
    assert.equal(res.statusCode, 200);
    assert.equal(deviceCodeCalls.length, before + 1);
    assert.equal(deviceCodeCalls.at(-1).client_id, "CID-1");
  });

  it("update změní clientId, prázdný secret ponechá původní", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/oauth/apps",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ service: "google", clientId: "CID-2" }),
    });
    assert.equal(r.statusCode, 201);
    const creds = await resolveAppCredentials(ctx, "google");
    assert.deepEqual(creds, { clientId: "CID-2", clientSecret: "SEC-1" });
  });

  it("po smazání aplikace resolve vrátí null (shoda klíče i po delete)", async () => {
    await clearCreds();
    try {
      const creds = await resolveAppCredentials(ctx, "google");
      assert.equal(creds, null);
    } finally {
      await seedCreds("CID-9", "SEC-9");
    }
  });

  it("env fallback: když DB prázdná, použijí se HERTZ_OAUTH_GOOGLE_*", async () => {
    await clearCreds();
    process.env.HERTZ_OAUTH_GOOGLE_CLIENT_ID = "ENV-CID";
    process.env.HERTZ_OAUTH_GOOGLE_CLIENT_SECRET = "ENV-SEC";
    try {
      const creds = await resolveAppCredentials(ctx, "google");
      assert.deepEqual(creds, { clientId: "ENV-CID", clientSecret: "ENV-SEC" });
      // …a start je skutečně použije při volání Googlu
      const before = deviceCodeCalls.length;
      const res = await app.inject({ method: "POST", url: "/api/oauth/google/device/start" });
      assert.equal(res.statusCode, 200);
      assert.equal(deviceCodeCalls.at(-1).client_id, "ENV-CID");
    } finally {
      delete process.env.HERTZ_OAUTH_GOOGLE_CLIENT_ID;
      delete process.env.HERTZ_OAUTH_GOOGLE_CLIENT_SECRET;
      await seedCreds("CID-1", "SEC-1");
    }
  });
});

describe("status vrací kód, dokud je session pending", () => {
  it("GET /device/status pro pending obsahuje user_code a verification_url", async () => {
    const start = await app.inject({ method: "POST", url: "/api/oauth/google/device/start" });
    assert.equal(start.statusCode, 200);
    const { device_session_id, user_code, verification_url } = start.json();
    const { statusCode, body } = await getStatus(device_session_id);
    assert.equal(statusCode, 200);
    assert.equal(body.status, "pending");
    // I kdyby se start-response po cestě ztratila, UI má kód odkud vzít.
    assert.equal(body.user_code, user_code);
    assert.equal(body.user_code, "ABCD-EFGH");
    assert.equal(body.verification_url, verification_url);
  });
});

describe("bod 4: pruneDeviceSessions", () => {
  it("nemaže aktivní (pending) session, maže jen staré ukončené", () => {
    const now = Date.now();
    const old = now - 20 * 60 * 1000; // starší než TTL 10 min
    for (let i = 0; i < 100; i++) {
      const finished = i > 0;
      deviceSessions.set(`prune-${i}`, {
        id: `prune-${i}`,
        userId: "user-1",
        agentId: null,
        catalogId: "google",
        clientId: "x",
        clientSecret: "",
        deviceCode: "d",
        userCode: "u",
        verificationUrl: "v",
        intervalSec: 1,
        expiresInSec: 4,
        status: finished ? (i === 1 ? "connected" : "error") : "pending",
        finishedAt: finished ? (i === 1 ? now : old) : undefined,
      });
    }
    pruneDeviceSessions();
    const pruned = [...deviceSessions.keys()].filter((k) => k.startsWith("prune-"));
    assert.ok(deviceSessions.has("prune-0"), "aktivní pending session nesmí zmizet");
    assert.ok(deviceSessions.has("prune-1"), "čerstvě dokončená session nesmí zmizet");
    assert.ok(!deviceSessions.has("prune-2"), "stará dokončená session se má uklidit");
    assert.deepEqual(pruned.sort(), ["prune-0", "prune-1"]);
    deviceSessions.clear();
  });
});
