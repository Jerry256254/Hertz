import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVICE_POLL_INTERVAL_MS,
  deviceStatusText,
  fetchDeviceStatus,
  pollDeviceStatus,
  startDeviceFlow,
} from "../src/settings/deviceFlow.ts";

const DIR = dirname(fileURLToPath(import.meta.url));
const COMPONENT = readFileSync(join(DIR, "..", "src", "settings", "GoogleDeviceFlow.tsx"), "utf8");
const SETTINGS = readFileSync(join(DIR, "..", "src", "settings", "SettingsModal.tsx"), "utf8");

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2C00}-\u{2FEF}\u{FE0F}\u{200D}\u{3030}\u{303D}\u{3297}\u{3299}\u{00A9}\u{00AE}\u{203C}\u{2049}]/u;

/** Mock transport: fronta odpovědí + záznam volání. */
function mockTransport(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    transport: {
      postJson: async (path) => {
        calls.push(["POST", path]);
        return responses[i++];
      },
      getJson: async (path) => {
        calls.push(["GET", path]);
        return responses[i++];
      },
    },
  };
}

describe("deviceFlow: start", () => {
  it("volá start endpoint a vrátí kód, adresu a session", async () => {
    const fixture = {
      user_code: "ABCD-EFGH",
      verification_url: "https://google.com/device",
      expires_in: 600,
      device_session_id: "sess-1",
    };
    const { calls, transport } = mockTransport([fixture]);
    const res = await startDeviceFlow(transport);
    assert.deepEqual(res, fixture);
    assert.deepEqual(calls, [["POST", "/oauth/google/device/start"]]);
  });
});

describe("deviceFlow: polling", () => {
  it("polluje každé 3 s a končí na connected (pending → pending → connected)", async () => {
    const { calls, transport } = mockTransport([
      { status: "pending" },
      { status: "pending" },
      { status: "connected" },
    ]);
    const seen = [];
    const final = await pollDeviceStatus(transport, "sess-1", {
      intervalMs: 5,
      onStatus: (s) => seen.push(s.status),
    });
    assert.equal(final.status, "connected");
    assert.deepEqual(seen, ["pending", "pending", "connected"]);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(([m, p]) => m === "GET" && p === "/oauth/google/device/status?session=sess-1"));
  });

  it("expired je terminální a polling se zastaví", async () => {
    const { calls, transport } = mockTransport([{ status: "pending" }, { status: "expired", message: "vypršel" }]);
    const final = await pollDeviceStatus(transport, "sess-2", { intervalMs: 5 });
    assert.equal(final.status, "expired");
    assert.equal(final.message, "vypršel");
    assert.equal(calls.length, 2);
  });

  it("denied je terminální", async () => {
    const { transport } = mockTransport([{ status: "denied" }]);
    const final = await pollDeviceStatus(transport, "sess-3", { intervalMs: 5 });
    assert.equal(final.status, "denied");
  });

  it("přerušení přes AbortSignal polling zastaví (cleanup při unmount)", async () => {
    const { calls, transport } = mockTransport([{ status: "pending" }, { status: "pending" }, { status: "pending" }]);
    const ctrl = new AbortController();
    const p = pollDeviceStatus(transport, "sess-4", { intervalMs: 20, signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await assert.rejects(p, (e) => e instanceof DOMException && e.name === "AbortError");
    assert.ok(calls.length <= 2, `polling měl přestat, ale volal ${calls.length}x`);
  });

  it("výchozí interval pollingu je 3 s", () => {
    assert.equal(DEVICE_POLL_INTERVAL_MS, 3000);
  });

  it("fetchDeviceStatus kóduje session id do URL", async () => {
    const { calls, transport } = mockTransport([{ status: "pending" }]);
    await fetchDeviceStatus(transport, "a b/c");
    assert.equal(calls[0][1], "/oauth/google/device/status?session=a%20b%2Fc");
  });
});

describe("deviceFlow: české hlášky", () => {
  it("connected → „Připojeno“", () => {
    assert.match(deviceStatusText("connected"), /Připojeno/);
  });
  it("denied → lidské vysvětlení zamítnutí", () => {
    assert.match(deviceStatusText("denied"), /zamítl/);
  });
  it("expired → výzva ke „Zkusit znovu“", () => {
    assert.match(deviceStatusText("expired"), /Zkusit znovu/);
  });
  it("error → hláška serveru, jinak fallback", () => {
    assert.equal(deviceStatusText("error", "  vlastní text  "), "vlastní text");
    assert.match(deviceStatusText("error"), /Zkus to prosím znovu/);
  });
  it("pending → čekací hláška", () => {
    assert.match(deviceStatusText("pending"), /Čekám, až kód potvrdíš/);
  });
  it("žádná hláška neobsahuje emoji", () => {
    for (const s of ["pending", "connected", "denied", "expired", "error"]) {
      assert.ok(!EMOJI.test(deviceStatusText(s, "test")), `emoji ve statusu ${s}`);
    }
  });
});

describe("GoogleDeviceFlow: UI (inspekce zdroje)", () => {
  it("zobrazuje velký user_code s tlačítkem Kopírovat", () => {
    assert.ok(COMPONENT.includes("user_code"), "nezobrazuje user_code");
    assert.ok(COMPONENT.includes("text-[30px]"), "kód není velký");
    assert.ok(COMPONENT.includes("CopyButton"), "chybí CopyButton");
    assert.ok(COMPONENT.includes("Zkopírovat kód"), "chybí kopírování kódu");
  });
  it("verification_url je prostý text s tlačítkem Kopírovat", () => {
    assert.ok(COMPONENT.includes("verification_url"), "nezobrazuje verification_url");
    assert.ok(COMPONENT.includes("Zkopírovat adresu stránky"), "chybí kopírování adresy");
  });
  it("polluje status na pozadí s cleanupem při unmount", () => {
    assert.ok(COMPONENT.includes("pollDeviceStatus"), "nepolluje status");
    assert.ok(COMPONENT.includes("DEVICE_POLL_INTERVAL_MS"), "nepoužívá 3s interval");
    assert.ok(COMPONENT.includes("AbortController"), "chybí AbortController pro polling");
    assert.ok(COMPONENT.includes(".abort()"), "chybí abort pollingu při unmount");
  });
  it("expired/denied/error → „Zkusit znovu“ restartuje flow", () => {
    assert.ok(COMPONENT.includes("Zkusit znovu"), "chybí tlačítko Zkusit znovu");
    assert.ok(COMPONENT.includes("runFlow"), "retry nerestartuje flow");
  });
  it("sekundární možnost: přihlášení přes prohlížeč (relay zůstává)", () => {
    assert.ok(COMPONENT.includes("Jiná možnost"), "chybí sekundární odkaz");
    assert.ok(COMPONENT.includes("přihlášení přes prohlížeč"), "chybí text sekundární možnosti");
  });
});

describe("SettingsModal: napojení device flow", () => {
  it("Google má primární tlačítko „Připojit kódem“", () => {
    assert.ok(SETTINGS.includes("Připojit kódem"), "chybí tlačítko Připojit kódem");
    assert.ok(SETTINGS.includes("GoogleDeviceFlow"), "SettingsModal nerenderuje GoogleDeviceFlow");
  });
  it("web/relay cesta pro Google zůstává jako záložní (nic se nemazalo)", () => {
    assert.ok(
      SETTINGS.includes("/api/oauth/${c.service}/start?catalogId=${c.id}"),
      "relay start URL pro Google zmizela",
    );
  });
});
