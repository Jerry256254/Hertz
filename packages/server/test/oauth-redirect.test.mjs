import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkRedirectUri,
  isLoopbackHost,
  isPrivateNetworkHost,
  localNetworkOAuthBlockedMessage,
  PROVIDERS_REQUIRING_PUBLIC_REDIRECT,
} from "../dist/oauth/redirect-check.js";

/**
 * Regression tests for the proactive OAuth redirect check
 * (packages/server/src/oauth/redirect-check.ts):
 * Google/Notion reject redirect URIs on private-network addresses with a
 * cryptic 400 — instead of sending the user there, the start route shows a
 * plain-Czech explanation up front.
 */

describe("checkRedirectUri", () => {
  it("blokuje privátní IPv4 rozsahy (10.x, 172.16–31.x, 192.168.x)", () => {
    for (const host of ["10.0.0.5", "10.255.0.1", "172.16.0.1", "172.31.255.254", "192.168.100.161", "192.168.0.1"]) {
      const r = checkRedirectUri(`http://${host}:4173/api/oauth/google/callback`);
      assert.deepEqual(r, { ok: false, reason: "private-network-host" }, host);
    }
  });

  it("blokuje privátní IPv4 i přes https", () => {
    assert.deepEqual(checkRedirectUri("https://192.168.1.10/api/oauth/google/callback"), {
      ok: false,
      reason: "private-network-host",
    });
  });

  it("blokuje link-local a .local hosty", () => {
    assert.deepEqual(checkRedirectUri("http://169.254.10.20/api/oauth/google/callback"), {
      ok: false,
      reason: "private-network-host",
    });
    assert.deepEqual(checkRedirectUri("http://hertz.local:4173/api/oauth/google/callback"), {
      ok: false,
      reason: "private-network-host",
    });
    assert.deepEqual(checkRedirectUri("http://[fe80::1]/api/oauth/google/callback"), {
      ok: false,
      reason: "private-network-host",
    });
    assert.deepEqual(checkRedirectUri("http://[fd00::5]/api/oauth/google/callback"), {
      ok: false,
      reason: "private-network-host",
    });
  });

  it("povoluje localhost a loopback (i přes http)", () => {
    for (const host of ["localhost", "localhost:4173", "127.0.0.1:4173", "[::1]:4173"]) {
      assert.deepEqual(checkRedirectUri(`http://${host}/api/oauth/google/callback`), { ok: true }, host);
    }
  });

  it("povoluje veřejnou https doménu", () => {
    assert.deepEqual(checkRedirectUri("https://moje-domena.cz/api/oauth/google/callback"), { ok: true });
  });

  it("blokuje http na veřejné doméně i veřejné IP", () => {
    assert.deepEqual(checkRedirectUri("http://moje-domena.cz/api/oauth/google/callback"), {
      ok: false,
      reason: "http-not-loopback",
    });
    assert.deepEqual(checkRedirectUri("http://93.184.216.34/api/oauth/google/callback"), {
      ok: false,
      reason: "http-not-loopback",
    });
  });

  it("nerozliší 172.15.x a 172.32.x jako privátní", () => {
    assert.deepEqual(checkRedirectUri("http://172.15.9.9/api/oauth/google/callback"), {
      ok: false,
      reason: "http-not-loopback",
    });
    assert.deepEqual(checkRedirectUri("https://172.32.0.1/api/oauth/google/callback"), { ok: true });
  });
});

describe("isPrivateNetworkHost / isLoopbackHost", () => {
  it("loopback není privátní síť", () => {
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isPrivateNetworkHost("localhost"), false);
    assert.equal(isPrivateNetworkHost("127.0.0.1"), false);
  });

  it("rozpozná privátní rozsahy", () => {
    assert.equal(isPrivateNetworkHost("192.168.100.161"), true);
    assert.equal(isPrivateNetworkHost("10.9.0.2"), true);
    assert.equal(isPrivateNetworkHost("172.20.4.9"), true);
    assert.equal(isPrivateNetworkHost("example.com"), false);
    assert.equal(isPrivateNetworkHost("93.184.216.34"), false);
  });
});

describe("PROVIDERS_REQUIRING_PUBLIC_REDIRECT", () => {
  it("obsahuje google a notion, ne github (restrikce neověřena)", () => {
    assert.ok(PROVIDERS_REQUIRING_PUBLIC_REDIRECT.has("google"));
    assert.ok(PROVIDERS_REQUIRING_PUBLIC_REDIRECT.has("notion"));
    assert.ok(!PROVIDERS_REQUIRING_PUBLIC_REDIRECT.has("github"));
    assert.ok(!PROVIDERS_REQUIRING_PUBLIC_REDIRECT.has("slack"));
  });
});

describe("localNetworkOAuthBlockedMessage", () => {
  it("česká zpráva obsahuje klíčové prvky (lokální síť, SSH tunel, veřejná adresa)", () => {
    const msg = localNetworkOAuthBlockedMessage({
      service: "google",
      redirectUri: "http://192.168.100.161:4173/api/oauth/google/callback",
    });
    assert.match(msg, /lokální sít/i);
    assert.match(msg, /SSH tunel/);
    assert.match(msg, /ssh -L 4173:localhost:4173/);
    assert.match(msg, /veřejn/);
    assert.match(msg, /http:\/\/localhost:4173\/api\/oauth\/google\/callback/);
    assert.match(msg, /https:\/\/vase-domena\/api\/oauth\/google\/callback/);
    assert.match(msg, /Google/);
  });

  it("pojmenuje službu a cestu callbacku podle služby", () => {
    const msg = localNetworkOAuthBlockedMessage({
      service: "notion",
      redirectUri: "http://192.168.1.5:4173/api/oauth/notion/callback",
    });
    assert.match(msg, /Notion/);
    assert.match(msg, /\/api\/oauth\/notion\/callback/);
  });

  it("neobsahuje emoji ani technický žargon bez vysvětlení", () => {
    const msg = localNetworkOAuthBlockedMessage({
      service: "google",
      redirectUri: "http://192.168.100.161:4173/api/oauth/google/callback",
    });
    assert.ok(!/\p{Extended_Pictographic}/u.test(msg), "zpráva nesmí obsahovat emoji");
    assert.ok(!msg.includes("private IP"), "bez žargonu bez vysvětlení");
  });
});
