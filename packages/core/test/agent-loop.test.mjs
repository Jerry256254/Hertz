import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentLoopManager,
  DEFAULT_MAX_AUTO_CONTINUATIONS,
  DEFAULT_MAX_TURNS,
  MAX_ARTIFACT_NUDGES,
  ARTIFACT_GIVEUP_TEXT,
  ARTIFACT_NUDGE_TEXT,
  isArtifactDeliveryPending,
  sessionHasDeliveredFiles,
  textPromisesArtifact,
} from "../dist/agent/agent-loop.js";

/* ------------------------------------------------------------------ */
/* Mocks: in-memory persistence, scripted provider, fake tool FS.      */
/* ------------------------------------------------------------------ */

function makePersistence() {
  const messages = [];
  let seq = 0;
  const state = { status: "active", metadata: {}, memoryNotes: [], agentStatus: "" };
  return {
    state,
    messages,
    async appendMessage(msg) {
      const saved = { id: `m${++seq}`, createdAt: new Date(), ...msg };
      messages.push(saved);
      return saved;
    },
    async listMessages() {
      return [...messages];
    },
    async updateSessionStatus(_sid, status) {
      state.status = status;
    },
    async getSessionMetadata() {
      return { ...state.metadata };
    },
    async setSessionMetadata(_sid, meta) {
      state.metadata = meta;
    },
    async recordUsage() {},
    async updateAgentLastStatus(_aid, s) {
      state.agentStatus = s;
    },
    async appendMemoryNote(_aid, note, meta) {
      state.memoryNotes.push({ note, meta });
    },
  };
}

/**
 * Scripted mock LLM. Each entry = one model turn:
 * { text?, tools?: [{ id, name, input }], stopReason? }.
 * When the script runs out, the model politely ends the turn.
 */
function makeProviders(script) {
  let calls = 0;
  const adapter = {
    id: "mock",
    displayName: "mock",
    supportsCaching: false,
    cacheStrategy: "none",
    async listModels() {
      return [];
    },
    async chat() {
      throw new Error("chat() not used by the loop");
    },
    async *stream() {
      const turn = script[calls++] ?? { text: "Hotovo.", stopReason: "end_turn" };
      if (turn.text) yield { type: "text_delta", text: turn.text };
      for (const t of turn.tools ?? []) {
        yield { type: "tool_use_start", id: t.id, name: t.name };
        yield { type: "tool_use_delta", id: t.id, inputDelta: JSON.stringify(t.input) };
        yield { type: "tool_use_end", id: t.id };
      }
      yield {
        type: "message_end",
        stopReason: turn.stopReason ?? (turn.tools?.length ? "tool_use" : "end_turn"),
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
    async countTokens() {
      return 10;
    },
    pricing() {
      return undefined;
    },
  };
  return {
    modelCalls: () => calls,
    async getAdapter() {
      return adapter;
    },
  };
}

function makeTools(handlers) {
  const calls = [];
  return {
    calls,
    async listDefinitions() {
      return [];
    },
    async run(name, input, _ctx) {
      calls.push({ name, input });
      const h = handlers[name];
      if (!h) return { summary: `unknown tool ${name}`, isError: true };
      return h(input);
    },
  };
}

const noopSandbox = () => ({
  pathGuard: {},
  shellPolicy: {},
  audit: { record: async () => {} },
  artifacts: {},
});

function makeLoop({ persistence, providers, tools }) {
  return new AgentLoopManager({ providers, tools, persistence, sandbox: noopSandbox });
}

function collectEvents(loop, sessionId) {
  const events = [];
  const unsub = loop.subscribe(sessionId, (e) => events.push(e));
  return { events, unsub };
}

const baseConfig = (sessionId) => ({
  sessionId,
  agentId: "agent-1",
  projectId: "proj-1",
  rootId: "main",
  model: "mock-model",
  providerConfigId: "pc-1",
  systemPrompt: "Jsi testovací agent.",
  maxTurns: 20,
  maxAutoContinuations: 2,
});

const textMsg = (text) => [{ type: "text", text }];

/* ------------------------------------------------------------------ */
/* (a) Multi-step task: 6 tool calls run to completion, no intervention */
/* ------------------------------------------------------------------ */

describe("agent loop — long tasks run to completion", () => {
  it("finishes a 6-tool-call task without intervention", async () => {
    const persistence = makePersistence();
    const script = [];
    for (let i = 1; i <= 6; i++) {
      script.push({
        text: `Dělám krok ${i}.`,
        tools: [{ id: `t${i}`, name: "step", input: { n: i } }],
      });
    }
    script.push({ text: "Všech šest kroků je hotových.", stopReason: "end_turn" });
    const providers = makeProviders(script);
    const tools = makeTools({
      step: (input) => ({ summary: `krok ${input.n} dokončen` }),
    });
    const loop = makeLoop({ persistence, providers, tools });
    const { events, unsub } = collectEvents(loop, "s-multi");

    await loop.runToCompletion(
      baseConfig("s-multi"),
      textMsg("Udělej prosím těchto šest kroků pěkně postupně a na konci mi dej vědět."),
    );
    unsub();

    assert.equal(tools.calls.length, 6, "all six tool calls must run");
    assert.deepEqual(
      tools.calls.map((c) => c.input.n),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(providers.modelCalls(), 7, "six tool turns + one closing turn");
    assert.equal(persistence.state.status, "completed");
    assert.ok(
      events.some((e) => e.type === "done"),
      "done event emitted",
    );
  });

  it("keeps a generous, adaptive step budget for complex tasks", () => {
    assert.ok(DEFAULT_MAX_TURNS >= 100, "chunk size must fit complex multi-step tasks");
    assert.ok(
      DEFAULT_MAX_TURNS * (DEFAULT_MAX_AUTO_CONTINUATIONS + 1) >= 2000,
      "effective ceiling must allow very long autonomous runs",
    );
  });
});

/* ------------------------------------------------------------------ */
/* (b) E2E-ish: "HTML prezentace + PPTX" ends with files as attachments */
/* ------------------------------------------------------------------ */

describe("agent loop — promised artifacts must be delivered", () => {
  function presentationWorld() {
    const persistence = makePersistence();
    const files = new Map(); // fake workspace FS: path -> content
    const tools = makeTools({
      write_file: (input) => {
        files.set(input.path, input.content ?? "");
        return { summary: `Soubor ${input.path} zapsán.` };
      },
      send_file: (input) => {
        if (!files.has(input.path)) {
          return { summary: `Soubor "${input.path}" nelze odeslat: cesta neexistuje.`, isError: true };
        }
        const filename = input.path.split("/").pop();
        return {
          summary: `Soubor ${input.path} odeslán.`,
          fileAttachment: {
            id: `att-${filename}`,
            absolutePath: `/fake-workspace/${input.path}`,
            filename,
            size: 128,
            mimeType: "application/octet-stream",
            caption: input.caption,
          },
        };
      },
    });
    return { persistence, tools, files };
  }

  it("does not stop mid-task: nudges the agent and delivers HTML + PPTX as attachments", async () => {
    const { persistence, tools } = presentationWorld();
    // Mirrors the production failure: after two tool calls the model emits
    // "PPTX knihovna je v počítači. Teď ta hlavní prezentace." as PURE TEXT
    // with no tool calls — the old loop ended the run right there.
    const script = [
      {
        text: "Jdu na to.",
        tools: [{ id: "t1", name: "write_file", input: { path: "prezentace.html", content: "<html>prezentace</html>" } }],
      },
      { text: "PPTX knihovna je v počítači. Teď ta hlavní prezentace.", stopReason: "end_turn" },
      {
        text: "Dokončuji prezentaci.",
        tools: [
          { id: "t2", name: "write_file", input: { path: "prezentace.pptx", content: "PPTX-BYTESTREAM" } },
          { id: "t3", name: "send_file", input: { path: "prezentace.html", caption: "HTML prezentace" } },
        ],
      },
      {
        text: "Posílám i PPTX.",
        tools: [{ id: "t4", name: "send_file", input: { path: "prezentace.pptx", caption: "PPTX prezentace" } }],
      },
      { text: "Hotovo — obě prezentace máš v chatu jako přílohy.", stopReason: "end_turn" },
    ];
    const providers = makeProviders(script);
    const loop = makeLoop({ persistence, providers, tools });
    const { events, unsub } = collectEvents(loop, "s-pres");

    await loop.runToCompletion(
      baseConfig("s-pres"),
      textMsg("Udělej prezentaci, kde bude moderně ukázáno, co všechno dokážeš — jako HTML i jako PPTX."),
    );
    unsub();

    // The loop must NOT have stopped after the text-only turn.
    assert.equal(providers.modelCalls(), 5, "loop continues past the text-only 'teď ta hlavní prezentace' turn");
    // The guard nudged the agent back to work exactly once — as an in-memory
    // system-prompt injection, never as a persisted message: nothing carrying
    // the nudge text may end up in the message history (no fake "user" bubble).
    const persistedNudges = persistence.messages.filter((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes(ARTIFACT_NUDGE_TEXT.slice(0, 40))),
    );
    assert.equal(persistedNudges.length, 0, "guard nudge must not be persisted as a message");
    const guardNotices = events.filter(
      (e) => e.type === "notice" && typeof e.message === "string" && e.message.includes("Systémová kontrola"),
    );
    assert.equal(guardNotices.length, 1, "one completion-guard notice expected");
    // Both files were actually sent as attachments (web card / Telegram document).
    const sent = events.filter((e) => e.type === "file_sent");
    assert.deepEqual(
      sent.map((e) => e.attachment.filename).sort(),
      ["prezentace.html", "prezentace.pptx"],
    );
    assert.equal(persistence.state.status, "completed");
    assert.ok(events.some((e) => e.type === "done"));
  });

  it("never sends a file that does not exist", async () => {
    const { persistence, tools } = presentationWorld();
    const script = [
      {
        text: "Pošlu prezentaci.",
        tools: [{ id: "t1", name: "send_file", input: { path: "neexistuje.pptx" } }],
      },
      { text: "Hotovo.", stopReason: "end_turn" },
    ];
    const providers = makeProviders(script);
    const loop = makeLoop({ persistence, providers, tools });
    const { events, unsub } = collectEvents(loop, "s-missing");

    await loop.runToCompletion(baseConfig("s-missing"), textMsg("Pošli mi prezentaci."));
    unsub();

    assert.equal(
      events.filter((e) => e.type === "file_sent").length,
      0,
      "no file_sent for a nonexistent file",
    );
  });

  it("gives up honestly after repeated nudges instead of silently 'completing'", async () => {
    const { persistence, tools } = presentationWorld();
    const script = [
      { text: "Prezentaci ti hned pošlu.", stopReason: "end_turn" },
      { text: "Už to skoro je, ještě chvilku.", stopReason: "end_turn" },
      { text: "Hned to bude, slibuji.", stopReason: "end_turn" },
      { text: "Ještě moment…", stopReason: "end_turn" },
    ];
    const providers = makeProviders(script);
    const loop = makeLoop({ persistence, providers, tools });
    const { events, unsub } = collectEvents(loop, "s-giveup");

    await loop.runToCompletion(baseConfig("s-giveup"), textMsg("Vytvoř mi prosím prezentaci."));
    unsub();

    assert.equal(providers.modelCalls(), MAX_ARTIFACT_NUDGES + 1, "bounded nudges, then stop");
    // The guard never persists a message: the nudges surface only as notices.
    const persistedNudges = persistence.messages.filter((m) =>
      m.content.some((b) => b.type === "text" && b.text.startsWith("[Systémová kontrola dokončení")),
    );
    assert.equal(persistedNudges.length, 0, "guard nudge must not be persisted as a message");
    const guardNotices = events.filter(
      (e) => e.type === "notice" && typeof e.message === "string" && e.message.includes("Systémová kontrola"),
    );
    assert.equal(guardNotices.length, MAX_ARTIFACT_NUDGES, "one notice per guard intervention");
    // The user sees an honest message instead of a fake "hotovo".
    const honest = persistence.messages.find(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text.includes(ARTIFACT_GIVEUP_TEXT.slice(0, 40))),
    );
    assert.ok(honest, "honest user-visible give-up message persisted");
    assert.equal(persistence.state.status, "completed");
    assert.ok(
      persistence.state.memoryNotes.some((n) => n.note.includes("nedokončený")),
      "memory records the unfinished task",
    );
    assert.ok(events.some((e) => e.type === "done"));
  });

  it("does not nag when files were already delivered earlier in the session", async () => {
    const persistence = makePersistence();
    // Simulate an earlier run that already delivered a file.
    await persistence.appendMessage({
      sessionId: "s-early",
      role: "assistant",
      content: [{ type: "text", text: "Tady je prezentace." }],
      senderAgentId: "agent-1",
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      cost: 0,
      purpose: "agent_turn",
      attachments: [{ id: "a1", filename: "prezentace.html", size: 10, mimeType: "text/html", createdAt: new Date() }],
    });
    const script = [{ text: "Ještě jsem ti k tomu dopsal poznámku.", stopReason: "end_turn" }];
    const providers = makeProviders(script);
    const tools = makeTools({});
    const loop = makeLoop({ persistence, providers, tools });

    await loop.runToCompletion(baseConfig("s-early"), textMsg("Díky, ještě mi k té prezentaci dopiš poznámku."));
    const nudges = persistence.messages.filter(
      (m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text.startsWith("[Systémová kontrola dokončení")),
    );
    assert.equal(nudges.length, 0, "no nudge when a file was already delivered");
    assert.equal(persistence.state.status, "completed");
  });
});

/* ------------------------------------------------------------------ */
/* Unit: promise detection                                              */
/* ------------------------------------------------------------------ */

describe("artifact promise detection", () => {
  it("spots Czech artifact promises", () => {
    assert.ok(textPromisesArtifact("Udělej prezentaci, kde bude moderně ukázáno, co všechno dokážeš"));
    assert.ok(textPromisesArtifact("PPTX knihovna je v počítači. Teď ta hlavní prezentace."));
    assert.ok(textPromisesArtifact("Pošlu ti soubor ke stažení."));
    assert.ok(textPromisesArtifact("Připravím report v PDF."));
  });

  it("does not fire on ordinary chatter", () => {
    assert.ok(!textPromisesArtifact("Díky, to je vše."));
    assert.ok(!textPromisesArtifact("Napsal jsem dokumentaci k API."));
    assert.ok(!textPromisesArtifact("Opravil jsem chybu v kódu."));
    assert.ok(!textPromisesArtifact("Ahoj, jak se máš?"));
  });

  it("isArtifactDeliveryPending combines promise + delivery state", () => {
    const pending = (over = {}) => ({
      userText: "Vytvoř prezentaci.",
      assistantTexts: ["Jdu na to."],
      filesSentThisRun: 0,
      history: [],
      ...over,
    });
    assert.ok(isArtifactDeliveryPending(pending()));
    assert.ok(!isArtifactDeliveryPending(pending({ userText: "Jak se máš?", assistantTexts: ["Dobře."] })));
    assert.ok(!isArtifactDeliveryPending(pending({ filesSentThisRun: 1 })));
    assert.ok(
      !isArtifactDeliveryPending(
        pending({ history: [{ attachments: [{ filename: "x.html" }] }] }),
      ),
      "file delivered earlier in the session counts",
    );
    assert.ok(
      !isArtifactDeliveryPending(pending({ assistantTexts: ["Prezentaci? Žádný soubor jsem neslíbil."] })),
      "an explicit denial suppresses the guard",
    );
  });

  it("sessionHasDeliveredFiles reads attachments from history", () => {
    assert.ok(!sessionHasDeliveredFiles([]));
    assert.ok(!sessionHasDeliveredFiles([{ attachments: [] }]));
    assert.ok(sessionHasDeliveredFiles([{ attachments: [{ filename: "a.pptx" }] }]));
  });
});

/* ------------------------------------------------------------------ */
/* Approval parking: the user is told, the run parks visibly            */
/* ------------------------------------------------------------------ */

describe("agent loop — approval parking is never silent", () => {
  it("emits awaiting_input + a Czech notice and parks visibly on request_approval", async () => {
    const persistence = makePersistence();
    const script = [
      {
        text: "Připravil jsem e-mail.",
        tools: [{ id: "t1", name: "request_approval", input: { summary: "Odeslat e-mail Janu Novákovi" } }],
      },
    ];
    const providers = makeProviders(script);
    const tools = makeTools({
      request_approval: () => ({
        summary: "Approval request filed.",
        awaitUser: { question: "Schválení potřeba: Odeslat e-mail Janu Novákovi" },
      }),
    });
    const loop = makeLoop({ persistence, providers, tools });
    const { events, unsub } = collectEvents(loop, "s-approval");

    await loop.runToCompletion(baseConfig("s-approval"), textMsg("Pošli e-mail Janu Novákovi s nabídkou."));
    unsub();

    const awaiting = events.find((e) => e.type === "awaiting_input");
    assert.ok(awaiting, "awaiting_input emitted");
    assert.match(awaiting.question, /Schválení potřeba/);
    const notice = events.find((e) => e.type === "notice" && e.message.includes("Čekám na schválení"));
    assert.ok(notice, "Czech parking notice emitted — the user is told");
    assert.equal(persistence.state.status, "awaiting_input");
    assert.match(String(persistence.state.metadata.pendingQuestion ?? ""), /Schválení potřeba/);
    assert.ok(events.some((e) => e.type === "done"), "run ends after parking (resume happens on decision)");
  });
});
