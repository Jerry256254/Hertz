import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUARD_NUDGE_PREFIX,
  isInternalMessage,
  withoutInternalMessages,
} from "../src/lib/message-visibility.ts";

const DIR = dirname(fileURLToPath(import.meta.url));
const WEB = join(DIR, "..");
const CORE_AGENT_LOOP = readFileSync(join(WEB, "..", "core", "src", "agent", "agent-loop.ts"), "utf8");
const CHATVIEW = readFileSync(join(WEB, "src", "chat", "ChatView.tsx"), "utf8");
const MESSAGEVIEW = readFileSync(join(WEB, "src", "components", "MessageView.tsx"), "utf8");

function msg(overrides = {}) {
  return {
    id: "m1",
    sessionId: "s1",
    role: "user",
    content: [{ type: "text", text: "Ahoj, jak se máš?" }],
    tokensIn: 0,
    tokensOut: 0,
    cachedTokensIn: 0,
    cost: 0,
    purpose: "agent_turn",
    createdAt: "2026-09-22T21:00:00.000Z",
    ...overrides,
  };
}

function guardNudge(overrides = {}) {
  return msg({
    id: "guard-1",
    content: [
      {
        type: "text",
        text: "[Systémová kontrola dokončení — tato zpráva není od uživatele] Slíbil jsi uživateli soubor, ale zatím jsi žádný neodeslal nástrojem send_file.",
      },
    ],
    ...overrides,
  });
}

describe("prefix je synchronizovaný se serverem", () => {
  it("ARTIFACT_NUDGE_TEXT v core začíná stejným prefixem", () => {
    const m = CORE_AGENT_LOOP.match(/ARTIFACT_NUDGE_TEXT =\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    assert.ok(m, "ARTIFACT_NUDGE_TEXT v agent-loop.ts nenalezen");
    const serverPrefix = m[1];
    assert.ok(
      serverPrefix.startsWith(GUARD_NUDGE_PREFIX),
      `prefix se rozjel: server "${serverPrefix}" vs web "${GUARD_NUDGE_PREFIX}"`,
    );
  });
});

describe("isInternalMessage", () => {
  it("hidden: true je interní i s rolí user a běžným textem", () => {
    assert.equal(isInternalMessage(msg({ hidden: true })), true);
  });

  it("visible: false je interní", () => {
    assert.equal(isInternalMessage(msg({ visible: false })), true);
  });

  it("role system je interní", () => {
    assert.equal(isInternalMessage(msg({ role: "system" })), true);
  });

  it("guard zpráva s rolí user je interní (regrese: nesmí být zelená bublina)", () => {
    assert.equal(isInternalMessage(guardNudge()), true);
  });

  it("guard zpráva je interní i s bílými znaky na začátku", () => {
    const m = guardNudge();
    m.content[0].text = "\n  " + m.content[0].text;
    assert.equal(isInternalMessage(m), true);
  });

  it("guard zpráva je interní i bez příznaku (staré záznamy)", () => {
    const m = guardNudge();
    delete m.hidden;
    delete m.visible;
    assert.equal(isInternalMessage(m), true);
  });

  it("běžná zpráva uživatele není interní", () => {
    assert.equal(isInternalMessage(msg()), false);
  });

  it("běžná zpráva asistenta není interní", () => {
    assert.equal(
      isInternalMessage(msg({ role: "assistant", content: [{ type: "text", text: "Hotovo, tady je soubor." }] })),
      false,
    );
  });

  it("prefix uprostřed textu zprávu neskryje", () => {
    assert.equal(
      isInternalMessage(msg({ content: [{ type: "text", text: "Zpráva [Systémová kontrola dokončení] je jen citace." }] })),
      false,
    );
  });

  it("prázdná zpráva bez textu není interní", () => {
    assert.equal(isInternalMessage(msg({ content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] })), false);
  });
});

describe("withoutInternalMessages", () => {
  it("vyfiltruje guard zprávu, běžné zprávy zůstanou ve stejném pořadí", () => {
    const user = msg({ id: "u1" });
    const guard = guardNudge();
    const assistant = msg({ id: "a1", role: "assistant", content: [{ type: "text", text: "Rozumím." }] });
    const out = withoutInternalMessages([user, guard, assistant]);
    assert.deepEqual(out.map((m) => m.id), ["u1", "a1"]);
  });

  it("vyfiltruje zprávy s hidden/visible:false/system", () => {
    const list = [
      msg({ id: "u1" }),
      msg({ id: "h", hidden: true }),
      msg({ id: "v", visible: false }),
      msg({ id: "s", role: "system", content: [{ type: "text", text: "sys" }] }),
    ];
    assert.deepEqual(withoutInternalMessages(list).map((m) => m.id), ["u1"]);
  });

  it("prázdný seznam zůstane prázdný", () => {
    assert.deepEqual(withoutInternalMessages([]), []);
  });
});

describe("filtr je zapojený v renderovacích cestách", () => {
  it("ChatView filtruje zprávy před renderováním bloků", () => {
    assert.ok(
      CHATVIEW.includes("withoutInternalMessages(data?.messages"),
      "ChatView musí filtrovat zprávy přes withoutInternalMessages",
    );
  });

  it("MessageView nikdy nerenderuje interní zprávu", () => {
    assert.ok(
      MESSAGEVIEW.includes("if (isInternalMessage(message)) return null;"),
      "MessageView musí interní zprávu zahodit",
    );
  });

  it("export do Markdownu interní zprávy vynechává", () => {
    const exportFn = CHATVIEW.slice(CHATVIEW.indexOf("export function chatToMarkdown"));
    assert.ok(exportFn.includes("isInternalMessage(m)"), "chatToMarkdown musí filtrovat interní zprávy");
  });
});
