/**
 * Testy oauth-relay: kontrakt bounce endpointu, validace state,
 * open-redirect ochrana a garance, že se query parametry nelogují.
 *
 * Spuštění: nejdřív `npm run build` (testy importují z ../dist),
 * pak `npm test`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRelayServer } from "../dist/server.js";
import { signState, createNonce, verifyState } from "../dist/state.js";

const SECRET = "test-secret-0123456789abcdef";
const TARGET = "http://192.168.100.161:4173/api/oauth/google/callback";

function payload(overrides = {}) {
  return {
    target: TARGET,
    svc: "google",
    iat: Date.now(),
    nonce: createNonce(),
    ...overrides,
  };
}

function signed(overrides = {}, secret = SECRET) {
  return signState(payload(overrides), secret);
}

let server;
let base;

before(async () => {
  server = createRelayServer(SECRET);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

/** Zachytí vše, co se během `fn` zapíše na stdout/stderr. */
async function captureOutput(fn) {
  const chunks = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const hook = (chunk, encoding, cb) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = hook;
  process.stderr.write = hook;
  try {
    await fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
  return chunks.join("");
}

describe("signState / verifyState", () => {
  it("platný state projde ověřením a nese payload", () => {
    const p = payload();
    const result = verifyState(signState(p, SECRET), SECRET);
    assert.equal(result.ok, true);
    assert.equal(result.payload.target, p.target);
    assert.equal(result.payload.svc, "google");
    assert.equal(result.payload.nonce, p.nonce);
  });

  it("state podepsaný jiným secretem neprojde", () => {
    const result = verifyState(signed({}, "jinny-secret-0123456789"), SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_signature");
  });

  it("pozměněný payload neprojde (HMAC nesedí)", () => {
    const s = signed();
    const [v, raw, mac] = s.split(".");
    const tampered = `${v}.${raw.slice(0, -2)}xx.${mac}`;
    const result = verifyState(tampered, SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_signature");
  });

  it("expirovaný state (starší 10 minut) neprojde", () => {
    const result = verifyState(signed({ iat: Date.now() - 11 * 60 * 1000 }), SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "expired");
  });

  it("state z daleké budoucnosti neprojde", () => {
    const result = verifyState(signed({ iat: Date.now() + 10 * 60 * 1000 }), SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "expired");
  });

  it("neznámá služba neprojde", () => {
    const result = verifyState(signed({ svc: "github" }), SECRET);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_service");
  });
});

describe("GET /bounce — úspěšný bounce", () => {
  it("platný code+state → 302 na target s code, relay state se nepředává", async () => {
    // Target nese vnitřní state instance — relay ho nesmí přepsat svým tokenem.
    const state = signed({
      target: "http://192.168.100.161:4173/api/oauth/google/callback?state=INNER_HERTZ_STATE",
    });
    const res = await fetch(
      `${base}/bounce?code=AUTH_CODE_123&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.hostname, "192.168.100.161");
    assert.equal(loc.port, "4173");
    assert.equal(loc.pathname, "/api/oauth/google/callback");
    assert.equal(loc.searchParams.get("code"), "AUTH_CODE_123");
    assert.equal(loc.searchParams.get("state"), "INNER_HERTZ_STATE");
  });

  it("existující query v targetu se zachová", async () => {
    const state = signed({ target: "http://192.168.100.161:4173/cb?foo=bar" });
    const res = await fetch(
      `${base}/bounce?code=C&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.searchParams.get("foo"), "bar");
    assert.equal(loc.searchParams.get("code"), "C");
  });

  it("cizí query parametry se nepředávají dál", async () => {
    const state = signed();
    const res = await fetch(
      `${base}/bounce?code=C&state=${encodeURIComponent(state)}&evil=injected&code2=x`,
      { redirect: "manual" },
    );
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.searchParams.get("evil"), null);
    assert.equal(loc.searchParams.get("code2"), null);
  });
});

describe("GET /bounce — zamítnutí souhlasu providerem", () => {
  it("error od providera → 302 s error parametry (state se ověřuje stejně)", async () => {
    const state = signed();
    const res = await fetch(
      `${base}/bounce?error=access_denied&error_description=${encodeURIComponent("User denied")}&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.searchParams.get("error"), "access_denied");
    assert.equal(loc.searchParams.get("error_description"), "User denied");
    assert.equal(loc.searchParams.get("code"), null);
  });

  it("error s neplatným state → 400 (žádný volný bounce)", async () => {
    const res = await fetch(
      `${base}/bounce?error=access_denied&state=podvrzeny`,
      { redirect: "manual" },
    );
    assert.equal(res.status, 400);
  });
});

describe("GET /bounce — validace", () => {
  it("chybějící state → 400", async () => {
    const res = await fetch(`${base}/bounce?code=C`, { redirect: "manual" });
    assert.equal(res.status, 400);
  });

  it("prázdný dotaz → 400", async () => {
    const res = await fetch(`${base}/bounce`, { redirect: "manual" });
    assert.equal(res.status, 400);
  });

  it("poškozený state → 400", async () => {
    const res = await fetch(`${base}/bounce?code=C&state=nesmysl`, {
      redirect: "manual",
    });
    assert.equal(res.status, 400);
  });

  it("expirovaný state → 400", async () => {
    const state = signed({ iat: Date.now() - 20 * 60 * 1000 });
    const res = await fetch(
      `${base}/bounce?code=C&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(res.status, 400);
  });

  it("špatný HMAC → 400", async () => {
    const state = signed({}, "cizi-secret-0123456789abcdef");
    const res = await fetch(
      `${base}/bounce?code=C&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(res.status, 400);
  });

  const openRedirectTargets = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "//evil.com/ukradni",
    "data:text/html,<script>alert(1)</script>",
    "ftp://evil.com/x",
    "file:///etc/passwd",
    " http://192.168.100.161:4173/cb",
    "http://192.168.100.161:4173/cb\n",
    "",
  ];

  for (const target of openRedirectTargets) {
    it(`open-redirect pokus ${JSON.stringify(target)} → 400`, async () => {
      const state = signed({ target });
      const res = await fetch(
        `${base}/bounce?code=C&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      assert.equal(res.status, 400);
    });
  }

  it("400 odpověď neobsahuje autorizační kód ani state", async () => {
    const code = "SUPER_TAJNY_KOD_987";
    const res = await fetch(
      `${base}/bounce?code=${code}&state=podvrzeny`,
      { redirect: "manual" },
    );
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.ok(!body.includes(code), "kód unikl do těla 400 odpovědi");
    assert.ok(!body.includes("podvrzeny"), "state unikl do těla 400 odpovědi");
  });
});

describe("vedlejší routy", () => {
  it("GET /healthz → 200 ok", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  it("GET / → 200 s krátkým infem a odkazem na README", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("bounce"));
    assert.ok(body.includes("README"));
  });

  it("neznámá cesta → 404", async () => {
    const res = await fetch(`${base}/neexistuje`);
    assert.equal(res.status, 404);
  });

  it("POST /bounce → 405", async () => {
    const res = await fetch(`${base}/bounce`, { method: "POST" });
    assert.equal(res.status, 405);
  });
});

describe("nelogování citlivých údajů", () => {
  it("žádný výstup loggeru neobsahuje autorizační kód", async () => {
    const secretCode = "KOD_KTERY_NESMI_DO_LOGU_abc123";
    const state = signed();
    const output = await captureOutput(async () => {
      const res = await fetch(
        `${base}/bounce?code=${secretCode}&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      assert.equal(res.status, 302);
      await res.text();
      // i neúspěšný pokus s kódem v URL
      const bad = await fetch(`${base}/bounce?code=${secretCode}&state=x`, {
        redirect: "manual",
      });
      assert.equal(bad.status, 400);
      await bad.text();
    });
    assert.ok(
      !output.includes(secretCode),
      `autorizační kód se objevil ve výstupu loggeru: ${output.slice(0, 300)}`,
    );
    assert.ok(
      !output.includes("code="),
      `query parametr code se objevil ve výstupu loggeru`,
    );
  });
});
