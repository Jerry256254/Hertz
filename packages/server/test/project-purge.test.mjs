import test from "node:test";
import assert from "node:assert/strict";
import { telegramHelpText } from "../dist/channels/telegram-commands.js";
import { defaultAgentPrompt } from "../dist/agents/persona.js";

test("telegram 'Co umím' neobsahuje /projekty ani projektové příkazy", () => {
  const help = telegramHelpText();
  assert.ok(!/\/projekty\b/i.test(help), "nápověda nesmí zmiňovat /projekty");
  assert.ok(!/projekt/i.test(help), "nápověda nesmí obsahovat slovo projekt");
});

test("persona zakazuje rámování kolem otevřených složek", () => {
  const p = defaultAgentPrompt("Test");
  assert.ok(!/projekt/i.test(p), "persona nesmí obsahovat 'projekt'");
  assert.ok(
    /nikdy tím nezdravíš/i.test(p),
    "persona musí zakazovat zdravit otevřenou složkou/prostorem",
  );
});
