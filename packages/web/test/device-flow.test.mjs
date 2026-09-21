import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVICE_POLL_INTERVAL_MS,
  DeviceFlowSession,
  deviceStartAction,
  deviceStatusText,
  fetchDeviceStatus,
  pollDeviceStatus,
  startDeviceFlow,
} from "../src/settings/deviceFlow.ts";
import { api, ApiError } from "../src/lib/api.ts";

const DIR = dirname(fileURLToPath(import.meta.url));
const COMPONENT = readFileSync(join(DIR, "..", "src", "settings", "GoogleDeviceFlow.tsx"), "utf8");
const DEVICEFLOW = readFileSync(join(DIR, "..", "src", "settings", "deviceFlow.ts"), "utf8");
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
    // Polling žije v DeviceFlowSession (deviceFlow.ts); komponenta ji jen
    // jednou spustí při mountu a zničí při unmount.
    assert.ok(DEVICEFLOW.includes("pollDeviceStatus"), "session nepolluje status");
    assert.ok(DEVICEFLOW.includes("DEVICE_POLL_INTERVAL_MS"), "session nepoužívá 3s interval");
    assert.ok(COMPONENT.includes("new DeviceFlowSession"), "komponenta nevytváří DeviceFlowSession");
    assert.ok(COMPONENT.includes("session.start()"), "mount effect nespouští session");
    assert.ok(COMPONENT.includes("session.destroy()"), "chybí destroy session při unmount");
    assert.ok(DEVICEFLOW.includes(".abort()"), "chybí abort pollingu při unmount");
  });
  it("expired/denied/error → „Zkusit znovu“ restartuje flow", () => {
    assert.ok(COMPONENT.includes("Zkusit znovu"), "chybí tlačítko Zkusit znovu");
    assert.ok(COMPONENT.includes("session.start()"), "retry nerestartuje session");
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
    // Logika běhu žije v DeviceFlowSession (deviceFlow.ts), komponenta ji jen zrcadlí.
    assert.ok(DEVICEFLOW.includes("code: final.code"), "code ze statusu se nepředává");
    assert.ok(DEVICEFLOW.includes("guideUrl: final.guideUrl"), "guideUrl ze statusu se nepředává");
    assert.ok(COMPONENT.includes('phase.status === "error"'), "failed/error nemá strukturovanou kartu");
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

/* ── Regrese: restartovací smyčka device flow ─────────────────────────
 * Bug: useEffect(..., [runFlow]) se spouštěl znovu při každém re-renderu
 * rodiče, protože onConnected={refresh} má při každém renderu novou
 * identitu → nový POST /device/start, nový user_code, karta problikla
 * na „Připravuji kód…". Oprava: DeviceFlowSession žije po celý mount,
 * onConnected se drží ve stabilním refu, start() volá jen mount effect.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
async function ticks(n) {
  for (let i = 0; i < n; i++) await tick();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transport se skriptovanou frontou odpovědí + počítadlem volání. */
function scriptedTransport() {
  const calls = [];
  const queue = [];
  return {
    calls,
    postCount: () => calls.filter(([m]) => m === "POST").length,
    getCount: () => calls.filter(([m]) => m === "GET").length,
    enqueue(fn) {
      queue.push(fn);
    },
    transport: {
      postJson: async (path) => {
        calls.push(["POST", path]);
        const fn = queue.shift();
        if (!fn) throw new Error(`neočekávaný POST ${path}`);
        return fn();
      },
      getJson: async (path) => {
        calls.push(["GET", path]);
        const fn = queue.shift();
        if (!fn) throw new Error(`neočekávaný GET ${path}`);
        return fn();
      },
    },
  };
}

const START_OK = () => ({
  user_code: "ABCD-EFGH",
  verification_url: "https://google.com/device",
  expires_in: 600,
  device_session_id: "sess-1",
});
/** Nikdy se nedokončí — simuluje visící polling statusu. */
const hang = () => new Promise(() => {});

function harness(t, opts) {
  const phases = [];
  let connectedCalls = 0;
  const session = new DeviceFlowSession(
    t.transport,
    {
      onPhase: (p) => phases.push(p),
      onConnected: () => {
        connectedCalls++;
      },
    },
    opts ?? { pollIntervalMs: 5 },
  );
  return { phases, session, connectedCalls: () => connectedCalls };
}
const kinds = (h) => h.phases.map((p) => p.kind);

describe("DeviceFlowSession: start a kód", () => {
  it("start-ok → kód viditelný (waiting drží user_code), polling běží na pozadí", async () => {
    const t = scriptedTransport();
    t.enqueue(START_OK);
    t.enqueue(hang);
    const h = harness(t);
    h.session.start();
    await ticks(5);
    assert.deepEqual(kinds(h), ["starting", "waiting"]);
    assert.equal(h.phases[1].start.user_code, "ABCD-EFGH");
    assert.equal(h.phases[1].start.verification_url, "https://google.com/device");
    assert.equal(t.postCount(), 1);
    assert.equal(t.getCount(), 1, "polling statusu neběží na pozadí");
    h.session.destroy();
  });

  it("start-fail → inline chyba česky a konkrétně, žádný prázdný stav", async () => {
    const t = scriptedTransport();
    t.enqueue(() => {
      throw new ApiError(400, "Nejdřív vlož Client ID a secret TV klienta.", {
        code: "missing_client_id",
        action: "enter_credentials",
      });
    });
    const h = harness(t);
    h.session.start();
    await ticks(5);
    assert.deepEqual(kinds(h), ["starting", "startError"]);
    const err = h.phases[1].error;
    assert.equal(err.code, "missing_client_id");
    assert.match(err.message, /Client ID/);
    assert.ok(!EMOJI.test(err.message), "emoji v chybové hlášce");
    assert.ok(!h.phases.some((p) => p.kind === "waiting"), "prázdný stav se nesmí objevit");
    h.session.destroy();
  });

  it("prázdný user_code ze serveru → chyba, nikdy waiting s prázdným kódem", async () => {
    const t = scriptedTransport();
    t.enqueue(() => ({ user_code: "   ", verification_url: "https://google.com/device", expires_in: 600, device_session_id: "s" }));
    const h = harness(t);
    h.session.start();
    await ticks(5);
    assert.deepEqual(kinds(h), ["starting", "startError"]);
    assert.match(h.phases[1].error.message, /kód chybí/);
    assert.ok(!EMOJI.test(h.phases[1].error.message), "emoji v chybové hlášce");
    h.session.destroy();
  });

  it("chybějící verification_url ze serveru → chyba, nikdy waiting bez adresy", async () => {
    const t = scriptedTransport();
    t.enqueue(() => ({ user_code: "ABCD-EFGH", verification_url: "", expires_in: 600, device_session_id: "s" }));
    const h = harness(t);
    h.session.start();
    await ticks(5);
    assert.deepEqual(kinds(h), ["starting", "startError"]);
    assert.match(h.phases[1].error.message, /kód chybí/);
    h.session.destroy();
  });
});

describe("DeviceFlowSession: žádný restart při re-renderu rodiče", () => {
  it("opakované re-rendery (bez volání start) nespustí nový POST /device/start", async () => {
    const t = scriptedTransport();
    t.enqueue(START_OK);
    t.enqueue(hang);
    const h = harness(t);
    h.session.start(); // mount effect — jediný legitimní start
    await ticks(5);
    // Simulace libovolného počtu re-renderů rodiče (refetch, window-focus):
    // na session se nic nevolá, transport mlčí.
    for (let i = 0; i < 5; i++) await ticks(2);
    assert.equal(t.postCount(), 1, "re-render rodiče restartoval flow (nový POST /device/start)");
    assert.deepEqual(kinds(h), ["starting", "waiting"], "karta s kódem se překreslila");
    assert.equal(h.phases[1].start.user_code, "ABCD-EFGH", "kód se změnil pod rukama");
    h.session.destroy();
  });

  it("„Zkusit znovu“ → explicitní restart: nový POST a nový kód", async () => {
    const t = scriptedTransport();
    t.enqueue(START_OK);
    t.enqueue(hang);
    t.enqueue(() => ({ user_code: "WXYZ-1234", verification_url: "https://google.com/device", expires_in: 600, device_session_id: "sess-2" }));
    t.enqueue(hang);
    const h = harness(t);
    h.session.start();
    await ticks(5);
    h.session.start(); // explicitní „Zkusit znovu"
    await ticks(5);
    assert.equal(t.postCount(), 2, "retry neposlal nový POST /device/start");
    const waitings = h.phases.filter((p) => p.kind === "waiting");
    assert.equal(waitings.length, 2);
    assert.equal(waitings[1].start.user_code, "WXYZ-1234");
    h.session.destroy();
  });

  it("kód zůstává viditelný po celou dobu pollingu — stav se nemaže", async () => {
    const t = scriptedTransport();
    t.enqueue(START_OK);
    t.enqueue(() => ({ status: "pending" }));
    t.enqueue(() => ({ status: "pending" }));
    t.enqueue(() => ({ status: "connected" }));
    const h = harness(t);
    h.session.start();
    await wait(80);
    await ticks(5);
    assert.deepEqual(kinds(h), ["starting", "waiting", "connected"]);
    assert.equal(h.phases[1].start.user_code, "ABCD-EFGH", "kód se během pollingu ztratil");
    assert.equal(h.connectedCalls(), 1, "onConnected se nezavolal právě jednou");
    h.session.destroy();
  });

  it("expired během pollingu → failed s českou hláškou (žádné tiché zmizení)", async () => {
    const t = scriptedTransport();
    t.enqueue(START_OK);
    t.enqueue(() => ({ status: "expired" }));
    const h = harness(t);
    h.session.start();
    await wait(60);
    await ticks(5);
    assert.deepEqual(kinds(h), ["starting", "waiting", "failed"]);
    assert.equal(h.phases[2].status, "expired");
    h.session.destroy();
  });

  it("destroy() při unmount abortuje polling — žádné další GET, žádné chyby", async () => {
    const t = scriptedTransport();
    t.enqueue(START_OK);
    const statusGate = (() => {
      let resolve;
      const promise = new Promise((res) => {
        resolve = res;
      });
      return { promise, resolve };
    })();
    t.enqueue(() => statusGate.promise); // GET #1: visí, dokud ho test nepustí
    t.enqueue(hang); // kdyby polling pokračoval, skončil by tady
    // Dlouhý interval: destroy() zaručeně padne do rozespáného sleepu.
    const h = harness(t, { pollIntervalMs: 2000 });
    h.session.start();
    await ticks(5);
    assert.deepEqual(kinds(h), ["starting", "waiting"]);
    assert.equal(t.getCount(), 1);
    statusGate.resolve({ status: "pending" });
    await ticks(5); // GET #1 doběhl → polling teď spí ve sleep(2000)
    h.session.destroy(); // unmount
    await wait(60);
    await ticks(5);
    assert.equal(t.getCount(), 1, "polling po unmount pokračuje");
    assert.ok(
      !h.phases.some((p) => p.kind === "startError" || p.kind === "failed"),
      "abort při unmount musí být tichý",
    );
    assert.deepEqual(kinds(h), ["starting", "waiting"]);
  });
});

describe("GoogleDeviceFlow: wiring proti restartovací smyčce (inspekce zdroje)", () => {
  it("onConnected se drží ve stabilním refu — nic nezávisí na jeho identitě", () => {
    assert.ok(COMPONENT.includes("onConnectedRef"), "onConnected se nedrží ve stabilním refu");
    assert.ok(!/\[onConnected\]/.test(COMPONENT), "něco stále závisí na identitě onConnected");
    assert.ok(!COMPONENT.includes("[runFlow]"), "effect stále závisí na runFlow");
    assert.ok(!COMPONENT.includes("[begin]"), "effect stále závisí na begin");
  });
  it("session se vytváří jednou na mount; start volá jen mount effect", () => {
    assert.ok(COMPONENT.includes("new DeviceFlowSession"), "chybí DeviceFlowSession");
    assert.ok(
      COMPONENT.includes("useEffect(() => {\n    session.start();"),
      "mount effect nespouští session.start()",
    );
    assert.ok(COMPONENT.includes("session.destroy()"), "cleanup při unmount chybí");
  });
  it("karta s kódem se renderuje jen z waiting fáze (nikdy s prázdným kódem)", () => {
    assert.ok(COMPONENT.includes('phase.kind === "waiting"'), "kód se nerenderuje z waiting fáze");
    assert.ok(DEVICEFLOW.includes("kód chybí"), "session nezamítá prázdný user_code");
  });
});

describe("SettingsModal: uložení údajů → automatický start device flow", () => {
  it("saveApp.onSuccess u Googlu otevře device panel (setDeviceFor)", () => {
    assert.ok(SETTINGS.includes("setDeviceFor(c.id)"), "po uložení údajů se neotevírá device panel");
    assert.ok(
      SETTINGS.includes("Po uložení údajů TV klienta pokračovat rovnou device flow"),
      "chybí komentář k pokračování device flow po uložení",
    );
  });
  it("device panel renderuje GoogleDeviceFlow a ten startuje sám při mountu", () => {
    assert.ok(SETTINGS.includes("deviceFor === c.id"), "device panel se neváže na deviceFor");
    assert.ok(
      COMPONENT.includes("useEffect(() => {\n    session.start();"),
      "GoogleDeviceFlow nestartuje automaticky při mountu — uživatel by musel klikat",
    );
  });
  it("chyba startu je inline v panelu (StartErrorCard), ne mimo něj", () => {
    assert.ok(COMPONENT.includes("StartErrorCard"), "chybí inline chybová karta");
    assert.ok(COMPONENT.includes("Kód se nepodařilo připravit"), "chybí český nadpis chyby startu");
  });
});
