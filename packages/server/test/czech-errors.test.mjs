import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  zodErrorToCzech,
  sendZodError,
  CZECH_VALIDATION_FALLBACK,
} from "../dist/validation/czech-errors.js";

/**
 * Mapper Zod → čeština: žádný surový anglický Zod JSON se nesmí dostat do UI.
 */

const agentUpdate = z.object({
  model: z.string().min(1).optional(),
});
const providerCreate = z.object({
  provider: z.enum(["openai", "anthropic"]),
  label: z.string().trim().min(1),
  baseUrl: z.string().trim().url().optional(),
});

describe("zodErrorToCzech", () => {
  it("prázdný model → „Vyber nebo zadej model.\"", () => {
    const parsed = agentUpdate.safeParse({ model: "" });
    assert.ok(!parsed.success);
    assert.equal(zodErrorToCzech(parsed.error), "Vyber nebo zadej model.");
  });

  it("chybějící model → „Vyber nebo zadej model.\"", () => {
    const parsed = z.object({ model: z.string().min(1) }).safeParse({});
    assert.ok(!parsed.success);
    assert.equal(zodErrorToCzech(parsed.error), "Vyber nebo zadej model.");
  });

  it("prázdný label → česká hláška s názvem pole", () => {
    const parsed = providerCreate.safeParse({ provider: "openai", label: "   " });
    assert.ok(!parsed.success);
    const msg = zodErrorToCzech(parsed.error);
    assert.ok(msg.includes("název"), `chybí český popisek pole: ${msg}`);
    assert.ok(!msg.includes("too_small"), `surový Zod kód v hlášce: ${msg}`);
  });

  it("špatná URL → česká hláška o platné adrese", () => {
    const parsed = providerCreate.safeParse({ provider: "openai", label: "x", baseUrl: "neni-adresa" });
    assert.ok(!parsed.success);
    const msg = zodErrorToCzech(parsed.error);
    assert.ok(msg.includes("platná adresa"), `chybí zmínka o platné adrese: ${msg}`);
    assert.ok(!msg.includes("invalid_string"), `surový Zod kód v hlášce: ${msg}`);
  });

  it("neplatná enum hodnota → lidský text s možnostmi", () => {
    const parsed = providerCreate.safeParse({ provider: "deepseek", label: "x" });
    assert.ok(!parsed.success);
    const msg = zodErrorToCzech(parsed.error);
    assert.ok(msg.includes("Zvol platnou hodnotu"), `chybí lidský text: ${msg}`);
    assert.ok(msg.includes("openai"), `chybí výčet možností: ${msg}`);
    assert.ok(!msg.includes("invalid_enum_value"), `surový Zod kód v hlášce: ${msg}`);
  });

  it("neznámá chyba → obecná záložní hláška", () => {
    const parsed = z.object({ n: z.number() }).refine(() => false, { message: "custom" }).safeParse({ n: 1 });
    assert.ok(!parsed.success);
    assert.equal(zodErrorToCzech(parsed.error), CZECH_VALIDATION_FALLBACK);
    assert.equal(
      CZECH_VALIDATION_FALLBACK,
      "Zadané údaje nejsou v pořádku, zkontroluj je prosím.",
    );
  });

  it("výstup nikdy neobsahuje surový Zod JSON ani anglické kódy", () => {
    const schemas = [
      agentUpdate.safeParse({ model: "" }),
      providerCreate.safeParse({ provider: "openai", label: "" }),
      providerCreate.safeParse({ provider: "openai", label: "x", baseUrl: "x" }),
      providerCreate.safeParse({ provider: "nope", label: "x" }),
      z.object({ tags: z.array(z.string()).min(2) }).safeParse({ tags: ["a"] }),
      z.object({ email: z.string().email() }).safeParse({ email: "x" }),
      z.object({ age: z.number().min(18) }).safeParse({ age: 3 }),
    ];
    for (const parsed of schemas) {
      assert.ok(!parsed.success);
      const msg = zodErrorToCzech(parsed.error);
      assert.ok(!msg.includes('[{"code"'), `surový Zod JSON v hlášce: ${msg}`);
      assert.ok(!msg.includes("too_small"), `anglický kód v hlášce: ${msg}`);
      assert.ok(!msg.includes("invalid_string"), `anglický kód v hlášce: ${msg}`);
    }
  });
});

describe("sendZodError", () => {
  it("odpoví 400 s českou hláškou", async () => {
    const parsed = agentUpdate.safeParse({ model: "" });
    assert.ok(!parsed.success);
    const sent = {};
    const reply = {
      code: (c) => {
        sent.code = c;
        return { send: (body) => (sent.body = body) };
      },
    };
    sendZodError(reply, parsed.error);
    assert.equal(sent.code, 400);
    assert.equal(sent.body.error, "Vyber nebo zadej model.");
  });
});
