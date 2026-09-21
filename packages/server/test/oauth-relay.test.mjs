import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  signRelayState,
  verifyRelayState,
  RELAY_TTL_MS,
  oauthRelayBounceUrl,
} from "../dist/oauth/relay-state.js";
import { planOAuthStart, callbackRedirectUri } from "../dist/routes/oauth.js";
import { verifyState } from "../dist/oauth/oauth-service.js";
import { getConnector, setupHelpFor, adminSetupHelpFor, relayBounceUrlFor, copyableRelayUrlsFor } from "../dist/mcp/catalog.js";

/**
 * Testy OAuth relay (bounce) flow — packages/server/src/oauth/relay-state.ts
 * a integrace do routes/oauth.ts + mcp/catalog.ts.
 *
 * Kontrakt s relay workerem (packages/oauth-relay):
 * - state token: v1.<base64url(JSON)>.<base64url(HMAC-SHA256(rawPayloadB64, secret))>
 * - payload: { target, svc, iat, nonce }
 * - bounce URL: <HERTZ_OAUTH_RELAY_URL bez trailing slash>/bounce
 */

const ENV_KEYS = ["HERTZ_OAUTH_RELAY_URL", "HERTZ_OAUTH_STATE_SECRET"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setRelay(url = "https://relay.example.com/", secret = "test-relay-secret") {
  process.env.HERTZ_OAUTH_RELAY_URL = url;
  process.env.HERTZ_OAUTH_STATE_SECRET = secret;
}

const MASTER_KEY = randomBytes(32);

function startParams(service, instanceCallbackUri) {
  return {
    service,
    instanceCallbackUri,
    statePayload: {
      service,
      catalogId: service,
      agentId: null,
      projectId: null,
      userId: "user-1",
      nonce: "test-nonce",
    },
    masterKey: MASTER_KEY,
  };
}

function decodePayload(token) {
  const [, raw] = token.split(".");
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
}

describe("signRelayState", () => {
  it("vrací token ve formátu v1.<payload>.<sig> (base64url)", () => {
    const token = signRelayState("https://instance/api/oauth/google/callback?state=abc", "google", "tajny-secret");
    assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("payload nese target, svc, iat (epoch ms) a 16znakový hex nonce", () => {
    const before = Date.now();
    const token = signRelayState("https://instance/api/oauth/notion/callback", "notion", "s3cr3t");
    const p = decodePayload(token);
    assert.equal(p.target, "https://instance/api/oauth/notion/callback");
    assert.equal(p.svc, "notion");
    assert.ok(typeof p.iat === "number" && p.iat >= before && p.iat <= Date.now());
    assert.match(p.nonce, /^[0-9a-f]{16}$/);
  });

  it("každý podpis má jiný nonce (náhodnost)", () => {
    const a = decodePayload(signRelayState("t", "google", "s")).nonce;
    const b = decodePayload(signRelayState("t", "google", "s")).nonce;
    assert.notEqual(a, b);
  });

  it("RELAY_TTL_MS je 10 minut", () => {
    assert.equal(RELAY_TTL_MS, 10 * 60 * 1000);
  });
});

describe("verifyRelayState", () => {
  it("ověří vlastní podpis a vrátí payload", () => {
    const token = signRelayState("https://x/cb", "google", "secret");
    const p = verifyRelayState(token, "secret");
    assert.ok(p);
    assert.equal(p.target, "https://x/cb");
    assert.equal(p.svc, "google");
  });

  it("odmítne špatný secret a pozměněný payload", () => {
    const token = signRelayState("https://x/cb", "google", "secret");
    assert.equal(verifyRelayState(token, "jiny-secret"), undefined);
    const [v, raw, sig] = token.split(".");
    const tampered = `${v}.${Buffer.from(JSON.stringify({ target: "https://evil/cb", svc: "google", iat: Date.now(), nonce: "a".repeat(16) })).toString("base64url")}.${sig}`;
    assert.equal(verifyRelayState(tampered, "secret"), undefined);
  });

  it("odmítne cizí formát verze", () => {
    assert.equal(verifyRelayState("v2.abc.def", "secret"), undefined);
    assert.equal(verifyRelayState("nesmysl", "secret"), undefined);
  });
});

describe("oauthRelayBounceUrl", () => {
  it("bez env vrací undefined", () => {
    delete process.env.HERTZ_OAUTH_RELAY_URL;
    assert.equal(oauthRelayBounceUrl(), undefined);
  });

  it("sestaví <relay>/bounce a ořízne trailing slash", () => {
    process.env.HERTZ_OAUTH_RELAY_URL = "https://relay.example.com/";
    assert.equal(oauthRelayBounceUrl(), "https://relay.example.com/bounce");
    process.env.HERTZ_OAUTH_RELAY_URL = "https://relay.example.com";
    assert.equal(oauthRelayBounceUrl(), "https://relay.example.com/bounce");
  });
});

describe("planOAuthStart", () => {
  it("s relay env míří redirectUri na relay bounce (i pro privátní IP instance)", () => {
    setRelay();
    const plan = planOAuthStart(startParams("google", "http://192.168.1.10:4173/api/oauth/google/callback"));
    assert.equal(plan.ok, true);
    assert.equal(plan.viaRelay, true);
    assert.equal(plan.redirectUri, "https://relay.example.com/bounce");
  });

  it("s relay env je state podepsaný relay token nesoucí target s vnitřním Hertz state", () => {
    setRelay("https://relay.example.com", "sh");
    const plan = planOAuthStart(startParams("google", "http://192.168.1.10:4173/api/oauth/google/callback"));
    assert.equal(plan.ok, true);
    assert.match(plan.state, /^v1\./);
    const p = decodePayload(plan.state);
    assert.equal(p.svc, "google");
    assert.ok(p.target.startsWith("http://192.168.1.10:4173/api/oauth/google/callback?state="));
    // Vnitřní state ověří instance svým master klíčem — callback pak funguje beze změny.
    const innerState = new URL(p.target).searchParams.get("state");
    assert.ok(innerState);
    const inner = verifyState(MASTER_KEY, innerState);
    assert.ok(inner);
    assert.equal(inner.service, "google");
    assert.equal(inner.userId, "user-1");
    assert.equal(inner.catalogId, "google");
  });

  it("relay se použije i pro notion, ale ne pro github/slack/mistral", () => {
    setRelay();
    const notion = planOAuthStart(startParams("notion", "http://192.168.1.10:4173/api/oauth/notion/callback"));
    assert.equal(notion.ok, true);
    assert.equal(notion.redirectUri, "https://relay.example.com/bounce");
    const github = planOAuthStart(startParams("github", "http://192.168.1.10:4173/api/oauth/github/callback"));
    assert.equal(github.ok, true);
    assert.equal(github.viaRelay, false);
    assert.equal(github.redirectUri, "http://192.168.1.10:4173/api/oauth/github/callback");
  });

  it("bez relay env zůstává přímá callback URL instance (direct flow)", () => {
    delete process.env.HERTZ_OAUTH_RELAY_URL;
    const plan = planOAuthStart(startParams("google", "https://hertz.example.com/api/oauth/google/callback"));
    assert.equal(plan.ok, true);
    assert.equal(plan.viaRelay, false);
    assert.equal(plan.redirectUri, "https://hertz.example.com/api/oauth/google/callback");
    // State je klasický Hertz state podepsaný master klíčem (žádný v1. token).
    assert.doesNotMatch(plan.state, /^v1\./);
    const inner = verifyState(MASTER_KEY, plan.state);
    assert.ok(inner && inner.service === "google");
  });

  it("bez relay env privátní IP dál vrací srozumitelnou českou chybu (stávající chování)", () => {
    delete process.env.HERTZ_OAUTH_RELAY_URL;
    const plan = planOAuthStart(startParams("google", "http://192.168.1.10:4173/api/oauth/google/callback"));
    assert.equal(plan.ok, false);
    assert.match(plan.error, /lokální s/);
    assert.match(plan.error, /SSH tunel/);
  });

  it("relay bez HERTZ_OAUTH_STATE_SECRET vrací českou chybu, ne pád", () => {
    process.env.HERTZ_OAUTH_RELAY_URL = "https://relay.example.com";
    delete process.env.HERTZ_OAUTH_STATE_SECRET;
    const plan = planOAuthStart(startParams("google", "http://192.168.1.10:4173/api/oauth/google/callback"));
    assert.equal(plan.ok, false);
    assert.match(plan.error, /HERTZ_OAUTH_STATE_SECRET/);
    // Česky, lidsky — žádný stack trace ani technický žargon navíc.
    assert.match(plan.error, /tajný klíč/);
  });
});

describe("callbackRedirectUri", () => {
  it("s relay env vrací stejnou bounce URL jako start (kritické pro výměnu kódu)", () => {
    setRelay();
    const start = planOAuthStart(startParams("google", "http://192.168.1.10:4173/api/oauth/google/callback"));
    assert.equal(start.ok, true);
    const cb = callbackRedirectUri("google", "http", "192.168.1.10:4173");
    assert.equal(cb, start.redirectUri);
    assert.equal(cb, "https://relay.example.com/bounce");
    const startNotion = planOAuthStart(startParams("notion", "http://192.168.1.10:4173/api/oauth/notion/callback"));
    assert.equal(callbackRedirectUri("notion", "http", "192.168.1.10:4173"), startNotion.redirectUri);
  });

  it("bez relay env vrací přímou callback adresu instance", () => {
    delete process.env.HERTZ_OAUTH_RELAY_URL;
    assert.equal(
      callbackRedirectUri("google", "https", "hertz.example.com"),
      "https://hertz.example.com/api/oauth/google/callback",
    );
    assert.equal(
      callbackRedirectUri("notion", "http", "192.168.1.10:4173"),
      "http://192.168.1.10:4173/api/oauth/notion/callback",
    );
  });
});

describe("katalog: relay texty", () => {
  it("s relay env vrací google/notion zkrácený návod bez SSH tunelu", () => {
    setRelay();
    const google = getConnector("google");
    assert.ok(google);
    const help = setupHelpFor(google);
    assert.ok(help);
    assert.match(help, /Klikni na „Připojit“, přihlas se Googlem a potvrď souhlas — propojení proběhne samo\./);
    assert.doesNotMatch(help, /SSH tunel/);
    const notion = getConnector("notion");
    assert.ok(notion);
    assert.match(setupHelpFor(notion), /propojení proběhne samo/);
  });

  it("s relay env obsahuje admin návod bounce URL jako redirect URI", () => {
    setRelay("https://relay.example.com");
    const admin = adminSetupHelpFor(getConnector("google"));
    assert.ok(admin);
    assert.match(admin, /https:\/\/relay\.example\.com\/bounce/);
    assert.doesNotMatch(admin, /\{bounce\}/);
  });

  it("relayBounceUrlFor vrací bounce URL jen pro google/notion", () => {
    setRelay("https://relay.example.com");
    assert.equal(relayBounceUrlFor(getConnector("google")), "https://relay.example.com/bounce");
    assert.equal(relayBounceUrlFor(getConnector("notion")), "https://relay.example.com/bounce");
    assert.equal(relayBounceUrlFor(getConnector("github")), null);
  });

  it("copyableRelayUrlsFor vrací bounce URL s popiskem pro UI (tvar očekávaný frontendem)", () => {
    setRelay("https://relay.example.com");
    assert.deepEqual(copyableRelayUrlsFor(getConnector("google")), [
      { label: "Redirect URI pro Google Cloud Console", url: "https://relay.example.com/bounce" },
    ]);
    assert.deepEqual(copyableRelayUrlsFor(getConnector("notion")), [
      { label: "Redirect URI pro Notion integraci", url: "https://relay.example.com/bounce" },
    ]);
    assert.deepEqual(copyableRelayUrlsFor(getConnector("github")), []);
  });

  it("bez relay env zůstávají původní texty s SSH tunelem a bounce URL je null", () => {
    delete process.env.HERTZ_OAUTH_RELAY_URL;
    const google = getConnector("google");
    assert.ok(google);
    assert.match(setupHelpFor(google), /SSH tunel/);
    assert.equal(relayBounceUrlFor(google), null);
  });
});
