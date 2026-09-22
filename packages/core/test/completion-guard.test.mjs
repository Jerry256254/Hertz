import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentLoopManager,
  MAX_ARTIFACT_NUDGES,
  ARTIFACT_GIVEUP_TEXT,
  ARTIFACT_NUDGE_TEXT,
  isArtifactDeliveryPending,
  textLooksInternal,
  contentLooksInternal,
} from "../dist/agent/agent-loop.js";

/* ------------------------------------------------------------------ */
/* Mocks: in-memory persistence, capturing scripted provider.          */
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
 * Scripted mock LLM that also records every request it received, so tests can
 * assert what the model actually saw (system prompt, message history).
 */
function makeCapturingProviders(script) {
  let calls = 0;
  const seen = [];
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
    async *stream(req) {
      seen.push({
        system: req.system,
        messages: req.messages.map((m) => ({
          role: m.role,
          text: m.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(" "),
        })),
      });
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
    seen,
    modelCalls: () => calls,
    async getAdapter() {
      return adapter;
    },
  };
}

function makeTools(handlers) {
  return {
    async listDefinitions() {
      return [];
    },
    async run(name, input, _ctx) {
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

const baseConfig = (sessionId, extra = {}) => ({
  sessionId,
  agentId: "agent-1",
  projectId: "proj-1",
  rootId: "main",
  model: "mock-model",
  providerConfigId: "pc-1",
  systemPrompt: "Jsi testovací agent.",
  maxTurns: 20,
  maxAutoContinuations: 2,
  ...extra,
});

const textMsg = (text) => [{ type: "text", text }];

const NUDGE_PREFIX = "[Systémová kontrola dokončení";
const persistedNudgeTexts = (messages) =>
  messages.filter((m) => m.content.some((b) => b.type === "text" && b.text.includes(NUDGE_PREFIX)));

/* ------------------------------------------------------------------ */
/* 1. Guard intervenes on a real promise — without persisting anything */
/* ------------------------------------------------------------------ */

describe("completion guard — fires only on a real promise in the current run", () => {
  it("nudges the agent back to work via the run system prompt, never as a message", async () => {
    const persistence = makePersistence();
    const script = [
      { text: "Prezentaci ti hned pošlu.", stopReason: "end_turn" },
      { text: "Hotovo.", stopReason: "end_turn" },
    ];
    const providers = makeCapturingProviders(script);
    const loop = makeLoop({ persistence, providers, tools: makeTools({}) });
    const { events, unsub } = collectEvents(loop, "s-guard");

    await loop.runToCompletion(baseConfig("s-guard"), textMsg("Vytvoř mi prosím prezentaci."));
    unsub();

    // The loop kept working past the empty promise instead of "completing".
    assert.equal(providers.modelCalls(), MAX_ARTIFACT_NUDGES + 1, "bounded nudges, then honest stop");
    // The nudge reached the model through the run's system prompt…
    assert.ok(!providers.seen[0].system.includes(NUDGE_PREFIX), "first turn has a clean system prompt");
    assert.ok(
      providers.seen[1].system.includes(NUDGE_PREFIX),
      "after the guard fires the nudge is part of the system prompt",
    );
    // …but was NEVER persisted as a message — no fake "user" bubble anywhere.
    assert.equal(persistedNudgeTexts(persistence.messages).length, 0, "no persisted guard message");
    // The user is told honestly; the fixed notice carries no user content.
    const notices = events.filter((e) => e.type === "notice" && e.message.includes("Systémová kontrola"));
    assert.equal(notices.length, MAX_ARTIFACT_NUDGES);
    for (const n of notices) {
      assert.equal(
        n.message,
        "Systémová kontrola: agent slíbil soubor, ale neodeslal ho — vracím ho do práce.",
        "notice is a fixed string, never interpolates user text",
      );
    }
    const honest = persistence.messages.find(
      (m) =>
        m.role === "assistant" &&
        !m.hidden &&
        m.content.some((b) => b.type === "text" && b.text.includes(ARTIFACT_GIVEUP_TEXT.slice(0, 40))),
    );
    assert.ok(honest, "honest user-visible give-up message persisted");
    assert.equal(persistence.state.status, "completed");
  });

  it("does not fire on ordinary chatter ('ahoj' / 'mas pc?')", async () => {
    const persistence = makePersistence();
    const providers = makeCapturingProviders([
      { text: "Ahoj! Jak ti můžu pomoct?", stopReason: "end_turn" },
      { text: "Ano, běžím na serveru a jsem připravený.", stopReason: "end_turn" },
    ]);
    const loop = makeLoop({ persistence, providers, tools: makeTools({}) });
    const { events, unsub } = collectEvents(loop, "s-chatter");

    await loop.runToCompletion(baseConfig("s-chatter"), textMsg("ahoj"));
    await loop.runToCompletion(baseConfig("s-chatter"), textMsg("mas pc?"));
    unsub();

    assert.equal(providers.modelCalls(), 2, "each trivial turn ends the run immediately");
    assert.equal(
      events.filter((e) => e.type === "notice" && e.message.includes("Systémová kontrola")).length,
      0,
      "no guard notice on ordinary chatter",
    );
    assert.equal(persistedNudgeTexts(persistence.messages).length, 0, "no persisted guard message");
    assert.equal(persistence.state.status, "completed");
  });

  it("ignores a stale guard record left in history by an older build", async () => {
    const persistence = makePersistence();
    // Simulate what older builds persisted: the guard nudge as role "user".
    await persistence.appendMessage({
      sessionId: "s-stale",
      role: "user",
      content: [{ type: "text", text: ARTIFACT_NUDGE_TEXT }],
      senderAgentId: null,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      cost: 0,
      purpose: "agent_turn",
    });
    const providers = makeCapturingProviders([
      { text: "Ahoj! Co pro tebe můžu udělat?", stopReason: "end_turn" },
      { text: "Ano, běžím na serveru.", stopReason: "end_turn" },
    ]);
    const loop = makeLoop({ persistence, providers, tools: makeTools({}) });
    const { events, unsub } = collectEvents(loop, "s-stale");

    await loop.runToCompletion(baseConfig("s-stale"), textMsg("ahoj"));
    await loop.runToCompletion(baseConfig("s-stale"), textMsg("mas pc?"));
    unsub();

    // The stale record must not re-trigger the guard in the new runs.
    assert.equal(providers.modelCalls(), 2, "no extra guard turns from the stale record");
    assert.equal(
      events.filter((e) => e.type === "notice" && e.message.includes("Systémová kontrola")).length,
      0,
      "stale guard record causes no new intervention",
    );
    // The model never sees the stale injection again.
    for (const req of providers.seen) {
      for (const m of req.messages) {
        assert.ok(!m.text.includes(NUDGE_PREFIX), "stale nudge excluded from model context");
      }
      assert.ok(!req.system.includes(NUDGE_PREFIX), "stale nudge not in system prompt either");
    }
    assert.equal(persistence.state.status, "completed");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Internal loop messages are marked hidden + role system           */
/* ------------------------------------------------------------------ */

describe("completion guard — internal messages are marked hidden", () => {
  it("spin-guard nudge is persisted as hidden system, not a user message", async () => {
    const persistence = makePersistence();
    const script = [
      { text: "Zkouším.", tools: [{ id: "t1", name: "step", input: { n: 1 } }], stopReason: "tool_use" },
      { text: "Zkouším znovu.", tools: [{ id: "t2", name: "step", input: { n: 1 } }], stopReason: "tool_use" },
      { text: "Ještě jednou.", tools: [{ id: "t3", name: "step", input: { n: 1 } }], stopReason: "tool_use" },
      { text: "Hotovo.", stopReason: "end_turn" },
    ];
    const providers = makeCapturingProviders(script);
    const tools = makeTools({ step: () => ({ summary: "krok dokončen" }) });
    const loop = makeLoop({ persistence, providers, tools });

    await loop.runToCompletion(baseConfig("s-spin"), textMsg("Udělej tři kroky."));
    const nudge = persistence.messages.find((m) =>
      m.content.some((b) => b.type === "text" && b.text.startsWith("[System nudge — not from the user]")),
    );
    assert.ok(nudge, "spin nudge persisted");
    assert.equal(nudge.role, "system", "internal nudge is not role user");
    assert.equal(nudge.hidden, true, "internal nudge carries the hidden flag");
  });

  it("tool screenshots are persisted as hidden system context", async () => {
    const persistence = makePersistence();
    const script = [
      {
        text: "Fotím obrazovku.",
        tools: [{ id: "t1", name: "shot", input: {} }],
        stopReason: "tool_use",
      },
      { text: "Hotovo.", stopReason: "end_turn" },
    ];
    const providers = makeCapturingProviders(script);
    const tools = makeTools({
      shot: () => ({ summary: "screenshot pořízen", attachments: [{ mimeType: "image/png", data: "AAAA" }] }),
    });
    const loop = makeLoop({ persistence, providers, tools });

    await loop.runToCompletion(baseConfig("s-shot", { supportsVision: true }), textMsg("Vyfoť obrazovku."));
    const shots = persistence.messages.find((m) =>
      m.content.some((b) => b.type === "text" && b.text.startsWith("[Screenshots captured by tools")),
    );
    assert.ok(shots, "screenshot context persisted");
    assert.equal(shots.role, "system");
    assert.equal(shots.hidden, true);
  });

  it("ask_user stub tool_result is hidden internal plumbing", async () => {
    const persistence = makePersistence();
    const script = [
      {
        text: "Potřebuji upřesnit.",
        tools: [{ id: "t1", name: "ask_user", input: { question: "Jakou barvu?" } }],
        stopReason: "tool_use",
      },
    ];
    const providers = makeCapturingProviders(script);
    const loop = makeLoop({ persistence, providers, tools: makeTools({}) });

    await loop.runToCompletion(baseConfig("s-ask"), textMsg("Udělej něco."));
    const stub = persistence.messages.find((m) =>
      m.content.some((b) => b.type === "tool_result" && b.toolUseId === "t1"),
    );
    assert.ok(stub, "ask_user stub persisted");
    assert.equal(stub.role, "system");
    assert.equal(stub.hidden, true);
    assert.equal(persistence.state.status, "awaiting_input");
  });
});

/* ------------------------------------------------------------------ */
/* 3. Internal-text detection + trigger hardening (pure units)         */
/* ------------------------------------------------------------------ */

describe("completion guard — internal text detection", () => {
  it("recognizes legacy internal injections by prefix", () => {
    assert.ok(textLooksInternal("[Systémová kontrola dokončení — tato zpráva není od uživatele] …"));
    assert.ok(textLooksInternal("[System nudge — not from the user] You just called x…"));
    assert.ok(textLooksInternal("[Screenshots captured by tools — read them visually]"));
    assert.ok(textLooksInternal("[Interrupted — the agent was restarted before this tool could run.]"));
    assert.ok(!textLooksInternal("Ahoj, jak se máš?"));
    assert.ok(!textLooksInternal("Pošlu ti prezentaci."));
    assert.ok(
      contentLooksInternal([{ type: "text", text: "[Systémová kontrola dokončení] …" }]),
      "detects inside content blocks",
    );
    assert.ok(!contentLooksInternal([{ type: "text", text: "Běžná odpověď." }]));
  });

  it("isArtifactDeliveryPending never treats internal texts as promises", () => {
    const base = {
      userText: "ahoj",
      filesSentThisRun: 0,
      history: [],
    };
    // A stale nudge echoing in the assistant texts must not re-arm the guard.
    assert.ok(
      !isArtifactDeliveryPending({
        ...base,
        assistantTexts: [ARTIFACT_NUDGE_TEXT],
      }),
      "stale nudge text in assistant history is not a promise",
    );
    // A genuine promise still arms it.
    assert.ok(
      isArtifactDeliveryPending({ ...base, assistantTexts: ["Prezentaci ti hned pošlu."] }),
      "real promise still triggers",
    );
    // Ordinary chatter stays quiet.
    assert.ok(
      !isArtifactDeliveryPending({ ...base, assistantTexts: ["Ahoj! Jak ti můžu pomoct?"] }),
      "no false positive on greetings",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. No sensitive data leaks into logs or fixed notice texts          */
/* ------------------------------------------------------------------ */

describe("completion guard — no sensitive data in logs", () => {
  it("never logs user message content", async () => {
    const persistence = makePersistence();
    const providers = makeCapturingProviders([{ text: "Ahoj!", stopReason: "end_turn" }]);
    const loop = makeLoop({ persistence, providers, tools: makeTools({}) });
    const canary = "KANÁREK-tajná-data-987";
    const logs = [];
    const origWarn = console.warn;
    const origError = console.error;
    console.warn = (...a) => logs.push(a.map(String).join(" "));
    console.error = (...a) => logs.push(a.map(String).join(" "));
    try {
      await loop.runToCompletion(baseConfig("s-canary"), textMsg(`ahoj, tady je ${canary}`));
    } finally {
      console.warn = origWarn;
      console.error = origError;
    }
    assert.ok(
      logs.every((l) => !l.includes(canary)),
      "user content must never reach server logs",
    );
  });
});
