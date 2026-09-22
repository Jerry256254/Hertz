import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, sanitizeErrorMessage } from "../src/lib/api.ts";

/**
 * Obrana v hloubce na klientovi: surový Zod JSON ze serveru se nikdy
 * nesmí dostat do DOM — nahradí ho česká obecná hláška.
 */

const FALLBACK = "Zadané údaje nejsou v pořádku, zkontroluj je prosím.";
const RAW_ZOD = '[{"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["model"]}]';

describe("sanitizeErrorMessage", () => {
  it("surový Zod JSON nahradí českou hláškou", () => {
    assert.equal(sanitizeErrorMessage(RAW_ZOD), FALLBACK);
  });

  it("zprávu obsahující Zod kód nahradí českou hláškou", () => {
    assert.equal(sanitizeErrorMessage('Chyba: "code":"too_small" v poli'), FALLBACK);
    assert.equal(sanitizeErrorMessage('Validation failed: "path":["model"]'), FALLBACK);
  });

  it("běžnou českou hlášku nechá nedotčenou", () => {
    const msg = "Vyber nebo zadej model.";
    assert.equal(sanitizeErrorMessage(msg), msg);
  });

  it("běžnou anglickou hlášku serveru nechá nedotčenou", () => {
    const msg = "Provider not found";
    assert.equal(sanitizeErrorMessage(msg), msg);
  });
});

describe("api request — sanitizace chybové odpovědi", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("ApiError nikdy nenese surový Zod JSON", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: RAW_ZOD }),
    });
    await assert.rejects(
      api.post("/providers", { label: "" }),
      (err) => {
        assert.ok(err instanceof ApiError, `očekáván ApiError, dostal ${err?.constructor?.name}`);
        assert.equal(err.message, FALLBACK);
        assert.ok(!err.message.includes('[{"code"'), "surový Zod JSON v ApiError.message");
        return true;
      },
    );
  });

  it("českou hlášku ze serveru propustí beze změny", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "Vyber nebo zadej model." }),
    });
    await assert.rejects(
      api.patch("/agents/a1", { model: "" }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.message, "Vyber nebo zadej model.");
        return true;
      },
    );
  });
});
