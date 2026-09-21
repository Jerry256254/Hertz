import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  requestDeviceCode,
  pollDeviceToken,
  DeviceFlowError,
  DEVICE_FLOW_GUIDED_ERRORS,
  GOOGLE_DEVICE_CLIENT_GUIDE_URL,
  googleDeviceCodeUrl,
} from "../dist/oauth/device-flow.js";

/**
 * Testy OAuth 2.0 Device Authorization Grant (RFC 8628) —
 * packages/server/src/oauth/device-flow.ts. Vše proti mock fetch,
 * čas se řídí injektovanými hodinami (žádné reálné čekání).
 */

const SECRET = "mock-client-secret-XYZ";
const DEVICE_CODE = "mock-device-code-ABC";
const ACCESS_TOKEN = "mock-access-token-111";
const REFRESH_TOKEN = "mock-refresh-token-222";
const SENSITIVE = [SECRET, DEVICE_CODE, ACCESS_TOKEN, REFRESH_TOKEN];

/** Ruční hodiny: sleep jen posune čas a zaznamená prodlevy. */
function manualClock() {
  let t = 1_000_000;
  const waits = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

function jsonResponse(status, json) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

/** Mock fetch: vrací odpovědi postupně z fronty, zaznamenává volání. */
function mockFetch(queue) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url: String(url), params: new URLSearchParams(init.body) });
    const next = queue[Math.min(i++, queue.length - 1)];
    return typeof next === "function" ? next(calls.length) : next;
  };
  fn.calls = calls;
  return fn;
}

const deviceCodeOk = () =>
  jsonResponse(200, {
    device_code: DEVICE_CODE,
    user_code: "ABCD-EFGH",
    verification_url: "https://www.google.com/device",
    verification_uri_complete: "https://www.google.com/device?user_code=ABCD-EFGH",
    expires_in: 1800,
    interval: 5,
  });

const tokenPending = () => jsonResponse(400, { error: "authorization_pending" });
const tokenSuccess = () =>
  jsonResponse(200, {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_in: 3599,
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    token_type: "Bearer",
  });

function basePollOpts(clock, fetchImpl, overrides = {}) {
  return {
    clientId: "mock-client-id",
    clientSecret: SECRET,
    deviceCode: DEVICE_CODE,
    intervalSec: 5,
    expiresInSec: 1800,
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    ...overrides,
  };
}

/** Zachytí vyhozenou chybu (assert.rejects ji nevrací). */
async function catchError(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("očekávaná chyba nebyla vyhozena");
}

// Zachycení console pro test úniku citlivých dat.
let captured;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];
const originalConsole = Object.fromEntries(CONSOLE_METHODS.map((m) => [m, console[m]]));

beforeEach(() => {
  captured = [];
  for (const m of CONSOLE_METHODS) console[m] = (...args) => captured.push(args.map(String).join(" "));
});

afterEach(() => {
  for (const m of CONSOLE_METHODS) console[m] = originalConsole[m];
});

function assertNoSecretsLeaked(context) {
  const dump = captured.join("\n");
  for (const s of SENSITIVE) {
    assert.ok(!dump.includes(s), `${context}: do console uniklo citlivé datum`);
  }
}

describe("requestDeviceCode", () => {
  it("happy path: pošle client_id + scope form-urlencoded a vrátí kódy", async () => {
    const fetchImpl = mockFetch([deviceCodeOk()]);
    const res = await requestDeviceCode("mock-client-id", ["scope-a", "scope-b"], { fetchImpl });

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, googleDeviceCodeUrl());
    assert.equal(fetchImpl.calls[0].params.get("client_id"), "mock-client-id");
    assert.equal(fetchImpl.calls[0].params.get("scope"), "scope-a scope-b");
    assert.equal(res.deviceCode, DEVICE_CODE);
    assert.equal(res.userCode, "ABCD-EFGH");
    assert.equal(res.verificationUrl, "https://www.google.com/device");
    assert.equal(res.verificationUrlComplete, "https://www.google.com/device?user_code=ABCD-EFGH");
    assert.equal(res.expiresIn, 1800);
    assert.equal(res.interval, 5);
    assertNoSecretsLeaked("requestDeviceCode");
  });

  it("síťová chyba → network_error s českou zprávou", async () => {
    const err = await catchError(      requestDeviceCode("mock-client-id", ["scope-a"], {
        fetchImpl: async () => {
          throw new Error("boom");
        },
      }));
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "network_error");
    assert.match(err.message, /Server se teď nedostal ke Googlu/);
    assertNoSecretsLeaked("requestDeviceCode network");
  });

  it("chybějící Client ID → missing_client_id s českou výzvou", async () => {
    for (const badId of ["", "   "]) {
      const err = await catchError(requestDeviceCode(badId, ["scope-a"], { fetchImpl: mockFetch([]) }));
      assert.ok(err instanceof DeviceFlowError);
      assert.equal(err.code, "missing_client_id");
      assert.match(err.message, /Nejdřív vlož Client ID TV klienta/);
      for (const s of SENSITIVE) assert.ok(!err.message.includes(s));
    }
    assertNoSecretsLeaked("requestDeviceCode missing client id");
  });

  it("invalid_client → invalid_client_type s návodem na TV klienta", async () => {
    const err = await catchError(
      requestDeviceCode("mock-client-id", ["scope-a"], {
        fetchImpl: mockFetch([
          jsonResponse(400, { error: "invalid_client", error_description: "The OAuth client was not found." }),
        ]),
      }),
    );
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "invalid_client_type");
    assert.match(err.message, /TVs and Limited Input devices/);
    assertNoSecretsLeaked("requestDeviceCode invalid_client");
  });

  it("unauthorized_client → invalid_client_type", async () => {
    const err = await catchError(
      requestDeviceCode("mock-client-id", ["scope-a"], {
        fetchImpl: mockFetch([jsonResponse(400, { error: "unauthorized_client" })]),
      }),
    );
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "invalid_client_type");
    assert.match(err.message, /TVs and Limited Input devices/);
    assertNoSecretsLeaked("requestDeviceCode unauthorized_client");
  });

  it("jiná chyba providera → provider_error, error_description se zaloguje redakčně", async () => {
    const logs = [];
    const err = await catchError(
      requestDeviceCode("mock-client-id", ["scope-a"], {
        fetchImpl: mockFetch([
          jsonResponse(429, {
            error: "rate_limit_exceeded",
            // popis od Googlu může obsahovat naše client_id → musí se redigovat
            error_description: "Kvóta pro klienta mock-client-id vyčerpána, zkuste to později",
          }),
        ]),
        log: (m) => logs.push(m),
      }),
    );
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "provider_error");
    assert.match(err.message, /nevydal kód pro spárování/);
    // Log existuje, ale client_id je redigované.
    assert.equal(logs.length, 1);
    assert.match(logs[0], /rate_limit_exceeded/);
    assert.ok(!logs[0].includes("mock-client-id"), "log nesmí nést citlivá data");
    for (const s of SENSITIVE) assert.ok(!err.message.includes(s));
    assertNoSecretsLeaked("requestDeviceCode rate_limit");
  });

  it("nečitelná chybová odpověď (non-ok, bez JSON) → provider_error", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("no json");
      },
    });
    const err = await catchError(requestDeviceCode("mock-client-id", ["scope-a"], { fetchImpl }));
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "provider_error");
    assertNoSecretsLeaked("requestDeviceCode non-json");
  });
});

describe("chybový kontrakt", () => {
  it("guideUrl a seznam naváděných chybových kódů jsou exportované", () => {
    assert.equal(GOOGLE_DEVICE_CLIENT_GUIDE_URL, "https://console.cloud.google.com/apis/credentials");
    assert.ok(DEVICE_FLOW_GUIDED_ERRORS.includes("missing_client_id"));
    assert.ok(DEVICE_FLOW_GUIDED_ERRORS.includes("invalid_client_type"));
    assert.ok(!DEVICE_FLOW_GUIDED_ERRORS.includes("network_error"));
  });
});

describe("pollDeviceToken", () => {
  it("happy path: pending → pending → success, respektuje interval", async () => {
    const clock = manualClock();
    const pendingCalls = [];
    const fetchImpl = mockFetch([tokenPending(), tokenPending(), tokenSuccess()]);
    const tokens = await pollDeviceToken(
      basePollOpts(clock, fetchImpl, { onPending: (n) => pendingCalls.push(n) }),
    );

    assert.equal(tokens.accessToken, ACCESS_TOKEN);
    assert.equal(tokens.refreshToken, REFRESH_TOKEN);
    assert.equal(tokens.expiresIn, 3599);
    assert.deepEqual(pendingCalls, [1, 2]);
    // Prodleva před každým pokusem (i prvním): 3 pokusy × 5 s.
    assert.deepEqual(clock.waits, [5000, 5000, 5000]);
    // Požadavek nese grant_type device_code a client_secret (je nakonfigurován).
    const last = fetchImpl.calls.at(-1).params;
    assert.equal(last.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(last.get("device_code"), DEVICE_CODE);
    assert.equal(last.get("client_secret"), SECRET);
    assertNoSecretsLeaked("poll happy");
  });

  it("client_secret se neposílá, když není nakonfigurovaný", async () => {
    const clock = manualClock();
    const fetchImpl = mockFetch([tokenSuccess()]);
    await pollDeviceToken(basePollOpts(clock, fetchImpl, { clientSecret: undefined }));
    assert.ok(!fetchImpl.calls[0].params.has("client_secret"));
    assertNoSecretsLeaked("poll bez secretu");
  });

  it("slow_down zvýší interval o 5 s", async () => {
    const clock = manualClock();
    const fetchImpl = mockFetch([
      tokenPending(),
      jsonResponse(400, { error: "slow_down" }),
      tokenPending(),
      tokenSuccess(),
    ]);
    await pollDeviceToken(basePollOpts(clock, fetchImpl));
    // 5 s, 5 s, pak slow_down → 10 s, 10 s
    assert.deepEqual(clock.waits, [5000, 5000, 10000, 10000]);
    assertNoSecretsLeaked("poll slow_down");
  });

  it("access_denied → typovaná chyba s českou zprávou", async () => {
    const clock = manualClock();
    const fetchImpl = mockFetch([tokenPending(), jsonResponse(400, { error: "access_denied" })]);
    const err = await catchError(pollDeviceToken(basePollOpts(clock, fetchImpl)));
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "access_denied");
    assert.match(err.message, /zamítli/);
    assert.equal(fetchImpl.calls.length, 2);
    assertNoSecretsLeaked("poll access_denied");
    for (const s of SENSITIVE) assert.ok(!err.message.includes(s), "chybová zpráva nesmí nést citlivá data");
  });

  it("expired_token → typovaná chyba s českou zprávou", async () => {
    const clock = manualClock();
    const fetchImpl = mockFetch([jsonResponse(400, { error: "expired_token" })]);
    const err = await catchError(pollDeviceToken(basePollOpts(clock, fetchImpl)));
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "expired_token");
    assert.match(err.message, /vypršela/);
    assertNoSecretsLeaked("poll expired_token");
  });

  it("expires_in se respektuje: po vypršení končí českou chybou", async () => {
    const clock = manualClock();
    const fetchImpl = mockFetch([tokenPending()]);
    const err = await catchError(      pollDeviceToken(basePollOpts(clock, fetchImpl, { intervalSec: 5, expiresInSec: 10 })));
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "expired_token");
    assert.match(err.message, /vypršela/);
    // 2 pokusy (t=5 s, t=10 s), třetí už ne — deadline 10 s.
    assert.equal(fetchImpl.calls.length, 2);
    assert.deepEqual(clock.waits, [5000, 5000]);
    assertNoSecretsLeaked("poll expirace");
  });

  it("invalid_client při pollingu → invalid_client_type s návodem na TV klienta", async () => {
    const clock = manualClock();
    const logs = [];
    const fetchImpl = mockFetch([jsonResponse(400, { error: "invalid_client", error_description: "LEAK-" + SECRET })]);
    const err = await catchError(pollDeviceToken({ ...basePollOpts(clock, fetchImpl), log: (m) => logs.push(m) }));
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "invalid_client_type");
    assert.match(err.message, /TVs and Limited Input devices/);
    for (const s of SENSITIVE) assert.ok(!err.message.includes(s), "chybová zpráva nesmí nést citlivá data");
    // error_description se zalogoval, ale secret/device_code v něm jsou redigované.
    assert.equal(logs.length, 1);
    assert.match(logs[0], /invalid_client/);
    for (const s of SENSITIVE) assert.ok(!logs[0].includes(s), "log nesmí nést citlivá data");
    assertNoSecretsLeaked("poll invalid_client");
  });

  it("unauthorized_client při pollingu → invalid_client_type", async () => {
    const clock = manualClock();
    const fetchImpl = mockFetch([jsonResponse(403, { error: "unauthorized_client" })]);
    const err = await catchError(pollDeviceToken(basePollOpts(clock, fetchImpl)));
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "invalid_client_type");
    assert.match(err.message, /TVs and Limited Input devices/);
    assertNoSecretsLeaked("poll unauthorized_client");
  });

  it("jiná chyba providera při pollingu → provider_error s popisem v logu", async () => {
    const clock = manualClock();
    const logs = [];
    const fetchImpl = mockFetch([jsonResponse(500, { error: "server_error", error_description: "vnitřní chyba Googlu" })]);
    const err = await catchError(pollDeviceToken({ ...basePollOpts(clock, fetchImpl), log: (m) => logs.push(m) }));
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "provider_error");
    assert.match(err.message, /Google párování odmítl/);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /server_error/);
    for (const s of SENSITIVE) assert.ok(!logs[0].includes(s), "log nesmí nést citlivá data");
    assertNoSecretsLeaked("poll provider_error");
  });

  it("přechodný výpadek sítě během čekání → pokračuje dál", async () => {
    const clock = manualClock();
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls++;
      if (calls === 2) throw new Error("network down");
      return calls < 3 ? tokenPending() : tokenSuccess();
    };
    const tokens = await pollDeviceToken({ ...basePollOpts(clock, fetchImpl), fetchImpl });
    assert.equal(tokens.accessToken, ACCESS_TOKEN);
    assert.equal(calls, 3);
    assertNoSecretsLeaked("poll network blip");
  });

  it("chybějící refresh_token → provider_error s českým návodem", async () => {
    const clock = manualClock();
    const fetchImpl = mockFetch([jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3600 })]);
    const err = await catchError(pollDeviceToken(basePollOpts(clock, fetchImpl)));
    assert.ok(err instanceof DeviceFlowError);
    assert.equal(err.code, "provider_error");
    assert.match(err.message, /myaccount\.google\.com\/permissions/);
    assertNoSecretsLeaked("poll bez refresh tokenu");
  });
});
