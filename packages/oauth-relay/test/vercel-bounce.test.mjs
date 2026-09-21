/**
 * Testy Vercel adaptéru oauth-relay: sdílené jádro `bounce-core`,
 * serverless function `api/bounce.ts` a garance, že se query
 * parametry (code/state) nikdy nelogují.
 *
 * Spuštění: nejdřív `npm run build` (testy importují z ../dist),
 * pak `npm test`. Adaptér se v `before` hooku překládá lokálním tsc
 * do dočasného adresáře MIMO repo a po testech se maže.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { handleBounceRequest } from "../dist/bounce-core.js";
import { signState, createNonce } from "../dist/state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
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

/** Sestaví URLSearchParams z dvojic [klíč, hodnota] (bez ručního escapování). */
function paramsOf(entries) {
  const p = new URLSearchParams();
  for (const [key, value] of entries) {
    p.set(key, value);
  }
  return p;
}

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

/** Dočasně nastaví (nebo smaže) RELAY_STATE_SECRET, pak vrátí původní hodnotu. */
function withSecret(value, fn) {
  const prev = process.env.RELAY_STATE_SECRET;
  try {
    if (value === undefined) {
      delete process.env.RELAY_STATE_SECRET;
    } else {
      process.env.RELAY_STATE_SECRET = value;
    }
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.RELAY_STATE_SECRET;
    } else {
      process.env.RELAY_STATE_SECRET = prev;
    }
  }
}

describe("bounce-core: handleBounceRequest", () => {
  it("platný state → 302, code předán, vnitřní state zachován, relay state nepředán", () => {
    const relayState = signed({
      target: `${TARGET}?state=INNER_HERTZ_STATE`,
    });
    const result = handleBounceRequest(
      SECRET,
      "GET",
      paramsOf([
        ["code", "AUTH_CODE_123"],
        ["state", relayState],
      ]),
    );
    assert.equal(result.status, 302);
    const loc = new URL(result.location);
    assert.equal(loc.searchParams.get("code"), "AUTH_CODE_123");
    // Vnitřní state instance v targetu relay nesmí přepsat svým tokenem.
    assert.equal(loc.searchParams.get("state"), "INNER_HERTZ_STATE");
    assert.ok(
      !result.location.includes(relayState),
      "relay state unikl do redirect URL",
    );
    assert.equal(result.svc, "google");
  });

  it("error flow → 302 s error parametry, code se nepředává", () => {
    const result = handleBounceRequest(
      SECRET,
      "GET",
      paramsOf([
        ["error", "access_denied"],
        ["error_description", "User denied"],
        ["state", signed()],
      ]),
    );
    assert.equal(result.status, 302);
    const loc = new URL(result.location);
    assert.equal(loc.searchParams.get("error"), "access_denied");
    assert.equal(loc.searchParams.get("error_description"), "User denied");
    assert.equal(loc.searchParams.get("code"), null);
  });

  it("cizí query parametry se nepředávají dál", () => {
    const result = handleBounceRequest(
      SECRET,
      "GET",
      paramsOf([
        ["code", "C"],
        ["state", signed()],
        ["evil", "injected"],
      ]),
    );
    assert.equal(result.status, 302);
    const loc = new URL(result.location);
    assert.equal(loc.searchParams.get("evil"), null);
  });

  it("neplatný podpis → 400 s prostým textem", () => {
    const result = handleBounceRequest(
      SECRET,
      "GET",
      paramsOf([
        ["code", "C"],
        ["state", signed({}, "cizi-secret-0123456789abcdef")],
      ]),
    );
    assert.equal(result.status, 400);
    assert.equal(result.body, "Neplatný nebo expirovaný požadavek.");
    assert.ok(!result.body.includes("C"), "kód unikl do těla 400");
  });

  it("expirovaný state → 400", () => {
    const result = handleBounceRequest(
      SECRET,
      "GET",
      paramsOf([
        ["code", "C"],
        ["state", signed({ iat: Date.now() - 20 * 60 * 1000 })],
      ]),
    );
    assert.equal(result.status, 400);
  });

  it("open-redirect pokus (//evil.com/ukradni) → 400", () => {
    const result = handleBounceRequest(
      SECRET,
      "GET",
      paramsOf([
        ["code", "C"],
        ["state", signed({ target: "//evil.com/ukradni" })],
      ]),
    );
    assert.equal(result.status, 400);
  });

  it("chybějící state → 400", () => {
    const result = handleBounceRequest(SECRET, "GET", paramsOf([["code", "C"]]));
    assert.equal(result.status, 400);
    assert.equal(result.body, "Neplatný nebo expirovaný požadavek.");
  });

  it("metoda POST → 405", () => {
    const result = handleBounceRequest(
      SECRET,
      "POST",
      paramsOf([
        ["code", "C"],
        ["state", signed()],
      ]),
    );
    assert.equal(result.status, 405);
    assert.equal(result.body, "Metoda není povolena.");
  });

  it("metoda HEAD je povolena (stejně jako GET)", () => {
    const result = handleBounceRequest(
      SECRET,
      "HEAD",
      paramsOf([
        ["code", "C"],
        ["state", signed()],
      ]),
    );
    assert.equal(result.status, 302);
  });
});

describe("api/bounce.ts — Vercel adaptér", () => {
  let handler;
  let tmpDir;

  /** Minimální fake ServerResponse: sbírá status, hlavičky a tělo. */
  function fakeRes() {
    const res = {
      statusCode: -1,
      headers: {},
      body: "",
      writeHead(status, headers) {
        res.statusCode = status;
        Object.assign(res.headers, headers ?? {});
        return res;
      },
      end(chunk) {
        if (chunk !== undefined) res.body += String(chunk);
        return res;
      },
    };
    return res;
  }

  function fakeReq(url, method = "GET") {
    return { method, url, headers: {} };
  }

  before(async () => {
    // Adaptér se překládá lokálním tsc do dočasného adresáře mimo repo.
    // --rootDir je kořen balíčku, takže ../src/*.js importy zůstanou funkční.
    tmpDir = mkdtempSync(join(tmpdir(), "oauth-relay-vercel-"));
    const tscBin = join(PKG, "node_modules", "typescript", "bin", "tsc");
    try {
      execFileSync(
        process.execPath,
        [
          tscBin,
          "--strict",
          "--skipLibCheck",
          "--target",
          "es2022",
          "--module",
          "nodenext",
          "--moduleResolution",
          "nodenext",
          "--outDir",
          tmpDir,
          "--rootDir",
          PKG,
          join(PKG, "api", "bounce.ts"),
        ],
        { stdio: "pipe" },
      );
    } catch (err) {
      const detail = err.stderr ? String(err.stderr) : err.message;
      throw new Error(`kompilace api/bounce.ts selhala:\n${detail}`);
    }
    const mod = await import(pathToFileURL(join(tmpDir, "api", "bounce.js")).href);
    handler = mod.default;
    assert.equal(typeof handler, "function", "api/bounce.ts nemá default export handleru");
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("chybějící RELAY_STATE_SECRET → 500 s českým textem bez detailů", async () => {
    const output = await captureOutput(async () => {
      withSecret(undefined, () => {
        const res = fakeRes();
        handler(fakeReq(`/bounce?code=C&state=${encodeURIComponent(signed())}`), res);
        assert.equal(res.statusCode, 500);
        assert.ok(res.body.length > 0, "500 má mít tělo");
        assert.ok(
          !res.body.includes("RELAY_STATE_SECRET"),
          "detail konfigurace unikl do těla 500",
        );
        assert.ok(
          String(res.headers["Content-Type"]).includes("text/plain"),
          "500 má být text/plain",
        );
      });
    });
    assert.ok(
      !output.includes("RELAY_STATE_SECRET"),
      "název proměnné unikl do logu",
    );
  });

  it("krátký secret → 500", () => {
    withSecret("kratky", () => {
      const res = fakeRes();
      handler(fakeReq("/bounce"), res);
      assert.equal(res.statusCode, 500);
    });
  });

  it("platný požadavek → 302 s Location a no-store", () => {
    withSecret(SECRET, () => {
      const state = signed();
      const res = fakeRes();
      handler(
        fakeReq(`/bounce?code=AUTH_CODE_123&state=${encodeURIComponent(state)}`),
        res,
      );
      assert.equal(res.statusCode, 302);
      const loc = new URL(res.headers.Location);
      assert.equal(loc.hostname, "192.168.100.161");
      assert.equal(loc.searchParams.get("code"), "AUTH_CODE_123");
      assert.ok(
        String(res.headers["Cache-Control"]).includes("no-store"),
        "302 má mít Cache-Control: no-store",
      );
    });
  });

  it("neplatný state → 400, kód ani state v těle", () => {
    withSecret(SECRET, () => {
      const code = "KOD_ADAPTER_400_XYZ";
      const res = fakeRes();
      handler(fakeReq(`/bounce?code=${code}&state=podvrzeny`), res);
      assert.equal(res.statusCode, 400);
      assert.ok(!res.body.includes(code), "kód unikl do těla 400");
      assert.ok(!res.body.includes("podvrzeny"), "state unikl do těla 400");
    });
  });

  it("POST → 405", () => {
    withSecret(SECRET, () => {
      const res = fakeRes();
      handler(fakeReq("/bounce", "POST"), res);
      assert.equal(res.statusCode, 405);
    });
  });

  it("code ani state se neobjeví na stdout/stderr", async () => {
    const secretCode = "KOD_ADAPTER_NESMI_DO_LOGU_zzz789";
    const state = signed();
    const output = await captureOutput(async () => {
      withSecret(SECRET, () => {
        const ok = fakeRes();
        handler(
          fakeReq(`/bounce?code=${secretCode}&state=${encodeURIComponent(state)}`),
          ok,
        );
        assert.equal(ok.statusCode, 302);
        const bad = fakeRes();
        handler(fakeReq(`/bounce?code=${secretCode}&state=x`), bad);
        assert.equal(bad.statusCode, 400);
      });
    });
    assert.ok(
      !output.includes(secretCode),
      `autorizační kód se objevil ve výstupu: ${output.slice(0, 300)}`,
    );
    assert.ok(
      !output.includes(state),
      `state se objevil ve výstupu: ${output.slice(0, 300)}`,
    );
    assert.ok(!output.includes("code="), "query parametr code se objevil ve výstupu");
  });
});
