import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVICE_POLL_INTERVAL_MS,
  deviceStartAction,
  deviceStatusText,
  fetchDeviceStatus,
  pollDeviceStatus,
  startDeviceFlow,
} from "../src/settings/deviceFlow.ts";
import { api, ApiError } from "../src/lib/api.ts";

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

describe("deviceFlow: strukturované chyby startu", () => {
  it("explicitní action ze serveru má přednost (enter_credentials)", () => {
    assert.equal(
      deviceStartAction({ message: "x", action: "enter_credentials" }),
      "enter_credentials",
    );
  });
  it("explicitní action ze serveru má přednost (retry)", () => {
    assert.equal(deviceStartAction({ code: "missing_client_id", message: "x", action: "retry" }), "retry");
  });
  it("missing_client_id → vložení údajů (i bez explicitní action)", () => {
    assert.equal(deviceStartAction({ code: "missing_client_id", message: "x" }), "enter_credentials");
  });
  it("invalid_client_type → vložení údajů", () => {
    assert.equal(deviceStartAction({ code: "invalid_client_type", message: "x" }), "enter_credentials");
  });
  it("rate_limited / provider_error / network_error → zkusit znovu", () => {
    assert.equal(deviceStartAction({ code: "provider_error", message: "x" }), "retry");
    assert.equal(deviceStartAction({ code: "network_error", message: "x" }), "retry");
  });
  it("neznámý kód / žádný kód → zkusit znovu (bezpečný fallback)", () => {
    assert.equal(deviceStartAction({ code: "neco_jineho", message: "x" }), "retry");
    assert.equal(deviceStartAction({ message: "x" }), "retry");
  });
});

describe("api: ApiError nese strukturovaná pole chyby", () => {
  const origFetch = globalThis.fetch;
  function mockFetch(status, body) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  // node:test nepodporuje afterEach na top-level describe bez hooků — uklidíme ručně.
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("parsuje code, guideUrl a action z těla chyby", async () => {
    mockFetch(400, {
      error: "Nejdřív vložte Client ID a secret.",
      code: "missing_client_id",
      guideUrl: "https://example.com/navod",
      action: "enter_credentials",
    });
    try {
      await assert.rejects(
        api.post("/oauth/google/device/start"),
        (e) =>
          e instanceof ApiError &&
          e.status === 400 &&
          e.message === "Nejdřív vložte Client ID a secret." &&
          e.code === "missing_client_id" &&
          e.guideUrl === "https://example.com/navod" &&
          e.action === "enter_credentials",
      );
    } finally {
      restore();
    }
  });

  it("akceptuje snake_case varianty a pole message", async () => {
    mockFetch(502, {
      message: "Google je nedostupný.",
      error_code: "provider_error",
      guide_url: "https://example.com/g",
      action: "retry",
    });
    try {
      await assert.rejects(
        api.post("/oauth/google/device/start"),
        (e) =>
          e instanceof ApiError &&
          e.message === "Google je nedostupný." &&
          e.code === "provider_error" &&
          e.guideUrl === "https://example.com/g" &&
          e.action === "retry",
      );
    } finally {
      restore();
    }
  });

  it("starý formát (jen error text) dál funguje, pole jsou prázdná", async () => {
    mockFetch(400, { error: "jen text" });
    try {
      await assert.rejects(
        api.post("/oauth/google/device/start"),
        (e) => e instanceof ApiError && e.message === "jen text" && e.code === undefined && e.action === undefined,
      );
    } finally {
      restore();
    }
  });

  it("neznámá action se ignoruje (místo pádu)", async () => {
    mockFetch(400, { error: "x", action: "nuke_everything" });
    try {
      await assert.rejects(
        api.post("/oauth/google/device/start"),
        (e) => e instanceof ApiError && e.action === undefined,
      );
    } finally {
      restore();
    }
  });
});

describe("GoogleDeviceFlow: UI strukturovaných chyb (inspekce zdroje)", () => {
  it("chybová karta má primární akci „Vložit údaje“ pro chyby údajů", () => {
    assert.ok(COMPONENT.includes("Vložit údaje"), "chybí tlačítko Vložit údaje");
    assert.ok(COMPONENT.includes("Nejdřív vlož údaje klienta"), "chybí nadpis pro chybu údajů");
    assert.ok(COMPONENT.includes("onEnterCredentials"), "chybí prop onEnterCredentials");
  });
  it("zobrazuje odkaz na návod ze serveru (guideUrl)", () => {
    assert.ok(COMPONENT.includes("guideUrl"), "guideUrl se nezpracovává");
    assert.ok(COMPONENT.includes("Otevřít návod k nastavení"), "chybí odkaz na návod");
  });
  it("akci vybírá deviceStartAction (žádná generická hláška tam, kde známe příčinu)", () => {
    assert.ok(COMPONENT.includes("deviceStartAction"), "UI nerozlišuje akci podle kódu chyby");
  });
  it("selhání po startu (status error) používá stejnou strukturovanou kartu", () => {
    assert.ok(COMPONENT.includes('phase.status === "error"'), "failed/error nemá strukturovanou kartu");
  });
  it("status endpoint předává code i guideUrl do chybové karty", () => {
    assert.ok(COMPONENT.includes("code: final.code"), "code ze statusu se nepředává");
    assert.ok(COMPONENT.includes("guideUrl: final.guideUrl"), "guideUrl ze statusu se nepředává");
  });
  it("žádná nová hláška neobsahuje emoji", () => {
    for (const s of ["Nejdřív vlož údaje klienta", "Otevřít návod k nastavení", "Vložit údaje"]) {
      assert.ok(!EMOJI.test(s), `emoji v hlášce: ${s}`);
    }
  });
});

describe("SettingsModal: Google bez údajů TV klienta", () => {
  it("předem říká, co chybí, s primární akcí „Vložit údaje“", () => {
    assert.ok(
      SETTINGS.includes("Nejdřív vlož Client ID a Secret klienta typu TV"),
      "chybí předběžné upozornění na chybějící údaje",
    );
    assert.ok(SETTINGS.includes("Vložit údaje"), "chybí akce Vložit údaje");
  });
  it("„Připojit kódem“ je v tomto stavu neaktivní s vysvětlením", () => {
    assert.ok(SETTINGS.includes("bez nich kód nejde připravit"), "chybí vysvětlení neaktivního tlačítka");
  });
  it("device panel dostává onEnterCredentials vedoucí na formulář údajů", () => {
    assert.ok(SETTINGS.includes("onEnterCredentials"), "GoogleDeviceFlow nedostává onEnterCredentials");
  });
  it("po uložení údajů Googlu pokračuje device flow (ne web redirect)", () => {
    assert.ok(
      SETTINGS.includes("Po uložení údajů TV klienta pokračovat rovnou device flow"),
      "po uložení údajů se nepokračuje device flow",
    );
  });
});
