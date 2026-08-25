import { EventEmitter } from "node:events";
import { ProviderError, type ChatMessage, type ChatRequest, type ContentBlock, type ModelPricing, type StopReason, type UsageInfo } from "@kuclab-hertz/providers";
import type { ArtifactStore, ToolContext } from "@kuclab-hertz/tools";
import type { ActorContext, AuditSink, PathGuard, ShellPolicy } from "@kuclab-hertz/sandbox";
import type { PersistedMessage, PersistencePort, ProviderPort, ToolPort } from "../ports.js";
import { planCachePrefix } from "../context/cache-planner.js";
import { computeBudget, needsSummarization } from "../context/budget.js";

export interface SandboxBundle {
  pathGuard: PathGuard;
  shellPolicy: ShellPolicy;
  audit: AuditSink;
  artifacts: ArtifactStore;
  /** Set when the agent works inside its own container (docker backend) — shell tools route there. */
  computer?: import("@kuclab-hertz/tools").ComputerRuntime;
  /** Playwright daemon controller (docker backend only). */
  browser?: import("@kuclab-hertz/tools").BrowserController;
}

export interface AgentLoopConfig {
  sessionId: string;
  agentId: string;
  projectId: string;
  /** May be absent for tool-triggered runs (e.g. an agent replying in a direct conversation); used only for memory-note attribution. */
  userId?: string;
  rootId: string;
  model: string;
  providerConfigId: string;
  systemPrompt: string;
  /**
   * Model calls per auto-continue chunk. When the budget is exhausted but the
   * agent is still mid-work (a tool call came back, or new inbound mail is
   * pending), the loop extends itself by another chunk instead of dying — up
   * to maxAutoContinuations times, so long autonomous runs can genuinely run
   * for hours rather than silently stalling at an arbitrary 25-turn wall.
   */
  maxTurns?: number;
  /** Output-token cap per single model call (providers clamp to their own maximums). */
  maxTokens?: number;
  maxAutoContinuations?: number;
  /** Tools to withhold from the model this run (e.g. message_employee inside a direct conversation, where replies are in-thread instead). */
  excludeTools?: string[];
  /**
   * How the agent behaves this run:
   * - "plan": no tools at all — the agent only thinks and answers (a plan, not execution);
   * - "auto" (default): full tool access, including ask_user when it needs input only the user can give;
   * - "autonomous": works until the goal is done, never asks — ask_user is withheld.
   */
  mode?: "plan" | "auto" | "autonomous";
  /** Set when the triggering user/agent message was already persisted by the caller (message_employee into a conversation), so runLoop must not append it again. */
  prePersisted?: boolean;
  /** Skip the automatic "Was told: X — Y" memory note on termination (used by heartbeats, which would otherwise spam memory every tick). */
  suppressAutoMemory?: boolean;
  /** Model can read images — tool screenshot attachments are delivered as image blocks. */
  supportsVision?: boolean;
}

export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_MAX_AUTO_CONTINUATIONS = 20;

export type AgentLoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; summary: string; isError?: boolean }
  | { type: "message_saved"; message: PersistedMessage }
  | { type: "status"; status: "running" | "idle" | "error" | "paused" }
  | { type: "awaiting_input"; question: string }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "done" };

function safeJsonParse(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Trivial exchanges ("hi", "thanks", one-word pings) carry zero long-term
 * value — auto-capturing them is what made memory feel like a log of noise.
 * Deliberate remember/save_skill notes are unaffected.
 */
function isTrivialExchange(userMessage: ContentBlock[], statusLine: string): boolean {
  const text = userMessage
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 0 && words <= 3) return true;
  if (/^(aho[jy]|čau|cau|zdravím|zdravim|hi\b|hello\b|hey\b|dík|dik|díky|diky|thanks?|ok\b|pokec)/i.test(text)) return true;
  if (/^(done|hotovo|ok)\.?$/i.test(statusLine.trim())) return true;
  return false;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as Error).name === "AbortError";
}

function isTransientProviderError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof ProviderError) {
    const status = err.status ?? 0;
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  // fetch() network-level failures surface as TypeError in Node.
  return err instanceof TypeError;
}

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/**
 * Runs `fn`, retrying up to RETRY_DELAYS_MS.length times on transient provider
 * errors with exponential backoff. onRetry is only a telemetry hook. Aborts
 * propagate immediately; the sleep itself also aborts so stop() is responsive.
 */
async function retryTransient<T>(fn: () => Promise<T>, onRetry: (attempt: number, err: unknown) => void, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientProviderError(err)) throw err;
      onRetry(attempt + 1, err);
      const delay = RETRY_DELAYS_MS[attempt]!;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const abortErr = new Error("Aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          },
          { once: true },
        );
      });
    }
  }
}

function computeCost(usage: UsageInfo, pricing?: ModelPricing): number {
  if (!pricing) return 0;
  const uncachedInput = Math.max(0, usage.inputTokens - (usage.cachedInputTokens ?? 0));
  const input = (uncachedInput / 1_000_000) * pricing.inputPerMillion;
  const cached = ((usage.cachedInputTokens ?? 0) / 1_000_000) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion);
  const output = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  return input + cached + output;
}

function toChatMessages(history: PersistedMessage[]): ChatMessage[] {
  const cutoff = history.findLastIndex((m) => m.purpose === "summarization");
  const relevant = cutoff === -1 ? history : history.slice(cutoff);
  return relevant
    .filter((m): m is PersistedMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}

function extractTextSummary(blocks: ContentBlock[], maxLen: number): string {
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return blocks.some((b) => b.type === "image") ? "(sent an image)" : "(no text)";
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function deriveStatusLine(text: string): string {
  const firstLine = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "Done.";
  return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
}

const COMPACT_SYSTEM_PROMPT =
  "Summarize this conversation into a dense briefing so the agent can resume with full working context but far fewer tokens. Capture concretely: what the user wants, key decisions made and why, files/paths touched and their current state, what's already done, and what's left to do. This replaces the raw history entirely — write it as a briefing for yourself, not commentary about the conversation.";

interface PendingToolUse {
  id: string;
  name: string;
  inputRaw: string;
}

/**
 * Runs one session's agentic turn(s) as a background task keyed by sessionId,
 * decoupled from any single WebSocket connection's lifecycle. The DB (via
 * PersistencePort) is the source of truth for history; subscribe() gives a
 * live-tail feed for connected clients, but nothing about correctness depends
 * on a subscriber being present — closing the browser mid-run does not stop it.
 */
export class AgentLoopManager {
  private readonly emitters = new Map<string, EventEmitter>();
  private readonly running = new Set<string>();
  private readonly paused = new Map<string, boolean>();
  /** Resolvers woken by resume() — replaces the old 400 ms busy-poll. */
  private readonly pauseWaiters = new Map<string, Array<() => void>>();
  /** Aborting cancels the in-flight provider HTTP call; the loop then finalizes the session as stopped. */
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly deps: {
      providers: ProviderPort;
      tools: ToolPort;
      persistence: PersistencePort;
      sandbox: (sessionId: string) => SandboxBundle;
    },
  ) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  isPaused(sessionId: string): boolean {
    return this.paused.get(sessionId) === true;
  }

  /** Pauses between turns: the in-flight model call / tool finishes, then the loop waits here until resume(). */
  async pause(sessionId: string): Promise<boolean> {
    if (!this.running.has(sessionId)) return false;
    this.paused.set(sessionId, true);
    this.emit(sessionId, { type: "status", status: "paused" });
    await this.deps.persistence.updateSessionStatus(sessionId, "paused");
    return true;
  }

  async resume(sessionId: string): Promise<boolean> {
    if (!this.running.has(sessionId)) return false;
    if (this.paused.delete(sessionId)) {
      for (const wake of this.pauseWaiters.get(sessionId) ?? []) wake();
      this.pauseWaiters.delete(sessionId);
    }
    this.emit(sessionId, { type: "status", status: "running" });
    await this.deps.persistence.updateSessionStatus(sessionId, "active");
    return true;
  }

  /**
   * Hard-stops a running session: aborts the in-flight provider call and makes
   * the loop finalize (status completed, memory note) at the next opportunity.
   * Unlike pause(), work does not resume afterwards.
   */
  stop(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.paused.delete(sessionId);
    for (const wake of this.pauseWaiters.get(sessionId) ?? []) wake();
    this.pauseWaiters.delete(sessionId);
    return true;
  }

  private async waitIfPaused(sessionId: string): Promise<void> {
    while (this.paused.get(sessionId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.pauseWaiters.get(sessionId) ?? [];
        waiters.push(resolve);
        this.pauseWaiters.set(sessionId, waiters);
      });
    }
  }

  /**
   * Persists an inbound message (human or colleague) into a session without
   * starting a new run — the in-flight loop notices it between turns (it
   * reloads history from the DB and refuses to terminate while new inbound
   * messages are pending) and answers it without interrupting its current
   * work. senderAgentId null = the human user; otherwise a colleague agent
   * (direct conversations have both sides in one thread).
   */
  async appendInbound(sessionId: string, content: ContentBlock[], senderAgentId?: string | null): Promise<PersistedMessage> {
    const saved = await this.deps.persistence.appendMessage({
      sessionId,
      role: "user",
      content,
      senderAgentId: senderAgentId ?? null,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      cost: 0,
      purpose: "agent_turn",
    });
    this.emit(sessionId, { type: "message_saved", message: saved });
    return saved;
  }

  subscribe(sessionId: string, listener: (event: AgentLoopEvent) => void): () => void {
    const emitter = this.getEmitter(sessionId);
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  }

  private getEmitter(sessionId: string): EventEmitter {
    let emitter = this.emitters.get(sessionId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(50);
      this.emitters.set(sessionId, emitter);
    }
    return emitter;
  }

  private emit(sessionId: string, event: AgentLoopEvent): void {
    this.getEmitter(sessionId).emit("event", event);
  }

  /**
   * Like start(), but resolves once the loop finishes with the final assistant
   * message — used for agent-to-agent delegation (a manager's `assign_task` tool
   * awaiting an employee's session to completion) rather than a human watching a
   * live WS stream. Still goes through the same background loop and DB-backed
   * history as any other session; there is no separate "synchronous" code path.
   */
  runAndWait(config: AgentLoopConfig, userMessage: ContentBlock[]): Promise<PersistedMessage | undefined> {
    return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe(config.sessionId, (event) => {
        if (event.type === "error") {
          unsubscribe();
          reject(new Error(event.message));
        } else if (event.type === "done") {
          unsubscribe();
          this.deps.persistence
            .listMessages(config.sessionId)
            .then((messages) => resolve(messages[messages.length - 1]))
            .catch(reject);
        }
      });
      try {
        this.start(config, userMessage);
      } catch (err) {
        unsubscribe();
        reject(err as Error);
      }
    });
  }

  /**
   * Replaces everything before this point in the session with a single dense
   * summary message (marked `purpose: 'summarization'`), so future turns' history
   * is cheap again. Nothing is deleted from the DB — toChatMessages() just starts
   * reading from the most recent summarization marker instead of the beginning.
   */
  async compact(config: {
    sessionId: string;
    userId: string;
    providerConfigId: string;
    model: string;
  }): Promise<PersistedMessage> {
    if (this.running.has(config.sessionId)) {
      throw new Error(`Session ${config.sessionId} is running — wait for it to finish first`);
    }
    const { persistence, providers } = this.deps;
    const history = await persistence.listMessages(config.sessionId);
    const chatMessages = toChatMessages(history);
    if (chatMessages.length === 0) {
      throw new Error("Nothing to compact yet");
    }

    const adapter = await providers.getAdapter(config.providerConfigId);
    const res = await adapter.chat({
      model: config.model,
      system: COMPACT_SYSTEM_PROMPT,
      messages: chatMessages,
      maxTokens: 2048,
    });
    const summaryText =
      res.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim() || "(summary came back empty)";

    const cost = computeCost(res.usage, adapter.pricing(config.model));
    const saved = await persistence.appendMessage({
      sessionId: config.sessionId,
      role: "user",
      content: [{ type: "text", text: `[Conversation summary — earlier messages compacted to save context]\n\n${summaryText}` }],
      tokensIn: res.usage.inputTokens,
      tokensOut: res.usage.outputTokens,
      cachedTokensIn: res.usage.cachedInputTokens ?? 0,
      cost,
      purpose: "summarization",
    });
    await persistence.recordUsage({
      sessionId: config.sessionId,
      userId: config.userId,
      provider: adapter.id,
      model: config.model,
      purpose: "summarization",
      tokensIn: res.usage.inputTokens,
      tokensOut: res.usage.outputTokens,
      cachedTokensIn: res.usage.cachedInputTokens ?? 0,
      cost,
    });
    this.emit(config.sessionId, { type: "message_saved", message: saved });
    return saved;
  }

  /** Fire-and-forget variant of runToCompletion() — kept for interactive callers; the durable queue awaits runToCompletion() instead. */
  start(config: AgentLoopConfig, userMessage: ContentBlock[]): void {
    if (this.running.has(config.sessionId)) {
      throw new Error(`Session ${config.sessionId} is already running`);
    }
    void this.runToCompletion(config, userMessage).catch(() => {});
  }

  /**
   * Runs the agent loop to completion and resolves when it finishes (or rejects
   * on a fatal error). The durable job queue awaits this so a crash mid-run can
   * be retried from the DB instead of silently dropping the work.
   */
  async runToCompletion(config: AgentLoopConfig, userMessage: ContentBlock[]): Promise<void> {
    if (this.running.has(config.sessionId)) {
      throw new Error(`Session ${config.sessionId} is already running`);
    }
    this.running.add(config.sessionId);
    this.emit(config.sessionId, { type: "status", status: "running" });

    const controller = new AbortController();
    this.abortControllers.set(config.sessionId, controller);

    try {
      await this.runLoop(config, userMessage, controller.signal);
    } catch (err) {
      if (isAbortError(err)) {
        // Deliberate stop(): finalize as completed rather than erroring.
        await this.deps.persistence.updateSessionStatus(config.sessionId, "completed");
        await this.deps.persistence.appendMemoryNote(config.agentId, "Run stopped by the user mid-task.");
        this.emit(config.sessionId, { type: "notice", message: "Run stopped by the user." });
      } else {
        this.emit(config.sessionId, { type: "error", message: (err as Error).message });
        await this.deps.persistence.updateSessionStatus(config.sessionId, "error");
        throw err;
      }
    } finally {
      this.running.delete(config.sessionId);
      this.paused.delete(config.sessionId);
      this.abortControllers.delete(config.sessionId);
      this.emit(config.sessionId, { type: "status", status: "idle" });
      this.emit(config.sessionId, { type: "done" });
    }
  }

  private async runLoop(config: AgentLoopConfig, userMessage: ContentBlock[], signal: AbortSignal): Promise<void> {
    const { persistence, providers, tools } = this.deps;
    const sandbox = this.deps.sandbox(config.sessionId);
    // Tool-triggered runs (an agent replying in a direct conversation) may have no human
    // user behind them — recordUsage demands an id, so fall back to a placeholder.
    const userId = config.userId ?? "";

    // The triggering message is normally persisted here; prePersisted runs (a colleague's
    // message_employee landing in a direct conversation) already have it in the DB.
    if (!config.prePersisted) {
      const savedUserMsg = await persistence.appendMessage({
        sessionId: config.sessionId,
        role: "user",
        content: userMessage,
        senderAgentId: null,
        tokensIn: 0,
        tokensOut: 0,
        cachedTokensIn: 0,
        cost: 0,
        purpose: "agent_turn",
      });
      this.emit(config.sessionId, { type: "message_saved", message: savedUserMsg });
    }

    const adapter = await providers.getAdapter(config.providerConfigId);
    let toolDefs = await tools.listDefinitions(config.agentId);
    if (config.excludeTools?.length) {
      toolDefs = toolDefs.filter((def) => !config.excludeTools!.includes(def.name));
    }
    const mode = config.mode ?? "autonomous";
    if (mode === "plan") {
      toolDefs = [];
    }
    // Note: ask_user stays available in autonomous mode — Grok-Bot-style bots
    // ask clarifying questions when they genuinely need them, then continue.
    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxAutoContinuations = config.maxAutoContinuations ?? DEFAULT_MAX_AUTO_CONTINUATIONS;
    const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    let turnsRemaining = maxTurns;
    let continuationsUsed = 0;

    while (true) {
      // Pause takes effect between turns: the current model call / tool finishes first.
      await this.waitIfPaused(config.sessionId);
      turnsRemaining--;

      let history = await persistence.listMessages(config.sessionId);

      // Auto-compact: when the context nears the window limit, fold the older
      // conversation into one agent-written summary (the "Compact" divider in
      // the UI) and continue with the fresh, small history. Runs at most once
      // per turn, before the model call.
      if (history.length > 12) {
        const budget = computeBudget(history);
        if (needsSummarization(budget, 85)) {
          this.emit(config.sessionId, { type: "notice", message: "Context window nearly full — auto-compacting the conversation." });
          try {
            await this.compact({
              sessionId: config.sessionId,
              userId,
              providerConfigId: config.providerConfigId,
              model: config.model,
            });
            history = await persistence.listMessages(config.sessionId);
          } catch (err) {
            this.emit(config.sessionId, { type: "notice", message: `Auto-compact failed (${(err as Error).message}) — continuing with full history.` });
          }
        }
      }

      const chatMessages = toChatMessages(history);
      const snapshotId = history.length > 0 ? history[history.length - 1]!.id : null;

      const req: ChatRequest = {
        model: config.model,
        system: config.systemPrompt,
        messages: chatMessages,
        tools: toolDefs,
        maxTokens,
        cachePrefixMessageCount: planCachePrefix(adapter, chatMessages.length),
        signal,
      };

      // A model call that dies on a transient provider hiccup (rate limit, 5xx,
      // dropped connection) is retried with exponential backoff instead of failing
      // the whole session — long autonomous runs must survive provider flakiness.
      const consumeStream = async (): Promise<{
        assistantText: string;
        toolUses: PendingToolUse[];
        usage: UsageInfo;
        stopReason: StopReason;
      }> => {
        let assistantText = "";
        const toolUses: PendingToolUse[] = [];
        let usage: UsageInfo = { inputTokens: 0, outputTokens: 0 };
        let stopReason: StopReason = "end_turn";
        for await (const evt of adapter.stream(req)) {
          switch (evt.type) {
            case "text_delta":
              assistantText += evt.text;
              this.emit(config.sessionId, { type: "text_delta", text: evt.text });
              break;
            case "tool_use_start":
              toolUses.push({ id: evt.id, name: evt.name, inputRaw: "" });
              break;
            case "tool_use_delta": {
              const pending = toolUses.find((t) => t.id === evt.id);
              if (pending) pending.inputRaw += evt.inputDelta;
              break;
            }
            case "tool_use_end":
              break;
            case "message_end":
              usage = evt.usage;
              stopReason = evt.stopReason;
              break;
            case "error":
              throw new Error(
                config.model
                  ? `Provider stream error (model: ${config.model}): ${evt.message}. If this is a free/gateway model, it may not support tool calling — try a different model in the bot's settings.`
                  : evt.message,
              );
          }
        }
        return { assistantText, toolUses, usage, stopReason };
      };

      const { assistantText, toolUses, usage, stopReason } = await retryTransient(
        () => consumeStream(),
        (attempt, err) => {
          this.emit(config.sessionId, {
            type: "notice",
            message: `Provider call failed (${(err as Error).message}) — retrying in a moment (attempt ${attempt}).`,
          });
        },
        signal,
      );
      let pendingAwait: { question: string } | undefined;
      const visionAttachments: Array<{ tool: string; mimeType: string; data: string }> = [];

      const assistantBlocks: ContentBlock[] = [];
      if (assistantText) assistantBlocks.push({ type: "text", text: assistantText });
      for (const t of toolUses) {
        assistantBlocks.push({ type: "tool_use", id: t.id, name: t.name, input: safeJsonParse(t.inputRaw) });
      }

      const pricing = adapter.pricing(config.model);
      const cost = computeCost(usage, pricing);

      const savedAssistantMsg = await persistence.appendMessage({
        sessionId: config.sessionId,
        role: "assistant",
        content: assistantBlocks,
        senderAgentId: config.agentId,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        cachedTokensIn: usage.cachedInputTokens ?? 0,
        cost,
        purpose: "agent_turn",
      });
      await persistence.recordUsage({
        sessionId: config.sessionId,
        userId,
        provider: adapter.id,
        model: config.model,
        purpose: "agent_turn",
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        cachedTokensIn: usage.cachedInputTokens ?? 0,
        cost,
      });
      this.emit(config.sessionId, { type: "message_saved", message: savedAssistantMsg });

      // Terminate only if the agent isn't mid-tool-loop AND no new inbound message
      // (user or colleague) arrived since this turn's history snapshot — a message
      // sent while working must be answered rather than silently left for the next run.
      const hasInbound = await this.hasNewInboundMessage(config.sessionId, snapshotId);
      if ((stopReason !== "tool_use" || toolUses.length === 0) && !hasInbound) {
        await persistence.updateSessionStatus(config.sessionId, "completed");
        const statusLine = deriveStatusLine(assistantText);
        await persistence.updateAgentLastStatus(config.agentId, statusLine);
        // Auto-captured, in addition to whatever the agent chose to remember itself via
        // the remember tool — the point is every exchange leaves *something* behind,
        // not just the ones the model happened to judge worth a deliberate note.
        if (!config.suppressAutoMemory && !isTrivialExchange(userMessage, statusLine)) {
          await persistence.appendMemoryNote(
            config.agentId,
            `Was told: ${extractTextSummary(userMessage, 200)} — ${statusLine}`,
            { kind: "episode", importance: 1 },
          );
        }
        return;
      }

      const resultBlocks: ContentBlock[] = [];
      for (const t of toolUses) {
        const input = safeJsonParse(t.inputRaw);

        // ask_user stops the run: the question is persisted on the session and
        // the UI shows it with an answer field; POST /answer resumes with a new
        // run. A stub tool_result is appended so the history stays valid for
        // the provider (a tool_use must be followed by a tool_result).
        if (t.name === "ask_user") {
          const raw = input as { question?: unknown };
          const question =
            typeof raw?.question === "string" && raw.question.trim()
              ? raw.question.trim()
              : "(the agent wants your input)";
          this.emit(config.sessionId, { type: "tool_call", id: t.id, name: t.name, input });
          await persistence.appendMessage({
            sessionId: config.sessionId,
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: t.id,
                content: "The question is waiting for the user's answer in the UI.",
                isError: false,
              },
            ],
            senderAgentId: null,
            tokensIn: 0,
            tokensOut: 0,
            cachedTokensIn: 0,
            cost: 0,
            purpose: "agent_turn",
          });
          const meta = (await persistence.getSessionMetadata(config.sessionId)) ?? {};
          await persistence.setSessionMetadata(config.sessionId, {
            ...meta,
            pendingQuestion: question,
            pendingQuestionAgentId: config.agentId,
          });
          await persistence.updateSessionStatus(config.sessionId, "awaiting_input");
          this.emit(config.sessionId, { type: "awaiting_input", question });
          return;
        }

        this.emit(config.sessionId, { type: "tool_call", id: t.id, name: t.name, input });

        const ctx: ToolContext = {
          actor: {
            actorId: config.agentId,
            actorType: "agent",
            sessionId: config.sessionId,
            projectId: config.projectId,
            userId,
          } satisfies ActorContext,
          rootId: config.rootId,
          pathGuard: sandbox.pathGuard,
          shellPolicy: sandbox.shellPolicy,
          audit: sandbox.audit,
          artifacts: sandbox.artifacts,
          ...(sandbox.computer ? { computer: sandbox.computer } : {}),
          ...(sandbox.browser ? { browser: sandbox.browser } : {}),
        };

        const result = await tools.run(t.name, input, ctx);
        resultBlocks.push({
          type: "tool_result",
          toolUseId: t.id,
          content: result.summary,
          isError: result.isError,
        });
        if (result.attachments && result.attachments.length > 0) {
          visionAttachments.push(...result.attachments.map((a) => ({ tool: t.name, ...a })));
        }
        this.emit(config.sessionId, {
          type: "tool_result",
          id: t.id,
          name: t.name,
          summary: result.summary,
          isError: result.isError,
        });
        if (result.awaitUser && !pendingAwait) {
          pendingAwait = { question: result.awaitUser.question };
        }
      }

      // Only append a tool-result turn when tools actually ran — continuing the
      // loop because a new inbound message arrived (not because of a tool call)
      // must not litter an empty user message into the history.
      if (resultBlocks.length > 0) {
        await persistence.appendMessage({
          sessionId: config.sessionId,
          role: "user",
          content: resultBlocks,
          senderAgentId: null,
          tokensIn: 0,
          tokensOut: 0,
          cachedTokensIn: 0,
          cost: 0,
          purpose: "agent_turn",
        });
      }

      // Vision models get screenshots as real image blocks right after the
      // tool result — non-vision models never receive them.
      if (visionAttachments.length > 0 && config.supportsVision) {
        const imageBlocks: ContentBlock[] = visionAttachments.slice(0, 3).map((a) => ({
          type: "image" as const,
          mimeType: a.mimeType,
          data: a.data,
        }));
        await persistence.appendMessage({
          sessionId: config.sessionId,
          role: "user",
          content: [
            { type: "text", text: "[Screenshots captured by tools — read them visually]" },
            ...imageBlocks,
          ],
          senderAgentId: null,
          tokensIn: 0,
          tokensOut: 0,
          cachedTokensIn: 0,
          cost: 0,
          purpose: "agent_turn",
        });
        visionAttachments.length = 0;
      }

      // A human-in-the-loop gate (request_approval): park the session until the
      // decision arrives via the approvals inbox, a chat answer, or a channel.
      if (pendingAwait) {
        const meta = (await persistence.getSessionMetadata(config.sessionId)) ?? {};
        await persistence.setSessionMetadata(config.sessionId, { ...meta, pendingQuestion: pendingAwait.question, pendingQuestionAgentId: config.agentId });
        await persistence.updateSessionStatus(config.sessionId, "awaiting_input");
        this.emit(config.sessionId, { type: "awaiting_input", question: pendingAwait.question });
        return;
      }

      // Chunk boundary: reaching it while still mid-work extends the run instead
      // of ending it — up to maxAutoContinuations extensions, then finalize with
      // an honest note rather than leaving the session as a zombie "active".
      if (turnsRemaining <= 0) {
        if (continuationsUsed >= maxAutoContinuations) {
          const ceiling = maxTurns * (maxAutoContinuations + 1);
          await persistence.updateSessionStatus(config.sessionId, "completed");
          await persistence.appendMemoryNote(
            config.agentId,
            `Hit the ${ceiling}-turn safety ceiling mid-task — paused for direction. Continue with a follow-up message.`,
          );
          this.emit(config.sessionId, {
            type: "notice",
            message: `Turn ceiling (${ceiling} turns) reached — run finalized. Send another message to continue.`,
          });
          return;
        }
        continuationsUsed++;
        turnsRemaining = maxTurns;
        this.emit(config.sessionId, {
          type: "notice",
          message: `Still working after ${continuationsUsed * maxTurns} turns — extending this run automatically.`,
        });
      }
    }

    await persistence.updateSessionStatus(config.sessionId, "completed");
  }

  /** True when any new human/colleague message (real text or image, not tool-result plumbing) landed after the given snapshot message id. */
  private async hasNewInboundMessage(sessionId: string, snapshotId: string | null): Promise<boolean> {
    const history = await this.deps.persistence.listMessages(sessionId);
    const snapshotIndex = snapshotId ? history.findIndex((m) => m.id === snapshotId) : -1;
    for (const message of history.slice(snapshotIndex + 1)) {
      if (message.role !== "user") continue;
      if (message.content.some((b) => b.type === "text" || b.type === "image")) return true;
    }
    return false;
  }
}

/**
 * Closes a crash left open: when a process died mid-tool, the session history
 * ends with an assistant tool_use that never received its tool_result — a state
 * every provider rejects on the next call. Appends synthetic "interrupted"
 * results so the history is valid again and the run can be resumed. Idempotent:
 * a repaired history passes through unchanged.
 */
export async function repairSessionHistory(persistence: PersistencePort, sessionId: string): Promise<boolean> {
  const history = await persistence.listMessages(sessionId);
  // Scan entire history for any tool_use without matching tool_result (not just last message)
  const allToolUses: string[] = [];
  const covered = new Set<string>();
  for (const message of history) {
    for (const block of message.content) {
      if (block.type === "tool_use") allToolUses.push(block.id);
      if (block.type === "tool_result") covered.add(block.toolUseId);
    }
  }
  const missing = allToolUses.filter((id) => !covered.has(id));
  if (missing.length === 0) return false;

  await persistence.appendMessage({
    sessionId,
    role: "user",
    content: missing.map((id) => ({
      type: "tool_result" as const,
      toolUseId: id,
      content: "[Interrupted — the agent was restarted before this tool could run.]",
      isError: true,
    })),
    senderAgentId: null,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokensIn: 0,
    cost: 0,
    purpose: "agent_turn",
  });
  return true;
}
