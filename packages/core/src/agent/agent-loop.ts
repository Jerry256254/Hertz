import { EventEmitter } from "node:events";
import type { ChatMessage, ChatRequest, ContentBlock, ModelPricing, StopReason, UsageInfo } from "@kuclab-hertz/providers";
import type { ArtifactStore, ToolContext } from "@kuclab-hertz/tools";
import type { ActorContext, AuditSink, PathGuard, ShellPolicy } from "@kuclab-hertz/sandbox";
import type { PersistedMessage, PersistencePort, ProviderPort, ToolPort } from "../ports.js";
import { planCachePrefix } from "../context/cache-planner.js";

export interface SandboxBundle {
  pathGuard: PathGuard;
  shellPolicy: ShellPolicy;
  audit: AuditSink;
  artifacts: ArtifactStore;
}

export interface AgentLoopConfig {
  sessionId: string;
  agentId: string;
  projectId: string;
  userId: string;
  rootId: string;
  model: string;
  providerConfigId: string;
  systemPrompt: string;
  maxTurns?: number;
}

export type AgentLoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; summary: string; isError?: boolean }
  | { type: "message_saved"; message: PersistedMessage }
  | { type: "status"; status: "running" | "idle" | "error" }
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

  /** Enqueues a user turn and runs the agent loop to completion (or a tool-free reply) in the background. */
  start(config: AgentLoopConfig, userMessage: ContentBlock[]): void {
    if (this.running.has(config.sessionId)) {
      throw new Error(`Session ${config.sessionId} is already running`);
    }
    this.running.add(config.sessionId);
    this.emit(config.sessionId, { type: "status", status: "running" });

    void this.runLoop(config, userMessage)
      .catch(async (err) => {
        this.emit(config.sessionId, { type: "error", message: (err as Error).message });
        await this.deps.persistence.updateSessionStatus(config.sessionId, "error");
      })
      .finally(() => {
        this.running.delete(config.sessionId);
        this.emit(config.sessionId, { type: "status", status: "idle" });
        this.emit(config.sessionId, { type: "done" });
      });
  }

  private async runLoop(config: AgentLoopConfig, userMessage: ContentBlock[]): Promise<void> {
    const { persistence, providers, tools } = this.deps;
    const sandbox = this.deps.sandbox(config.sessionId);

    const savedUserMsg = await persistence.appendMessage({
      sessionId: config.sessionId,
      role: "user",
      content: userMessage,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      cost: 0,
      purpose: "agent_turn",
    });
    this.emit(config.sessionId, { type: "message_saved", message: savedUserMsg });

    const adapter = await providers.getAdapter(config.providerConfigId);
    const toolDefs = await tools.listDefinitions(config.agentId);
    const maxTurns = config.maxTurns ?? 25;

    for (let turn = 0; turn < maxTurns; turn++) {
      const history = await persistence.listMessages(config.sessionId);
      const chatMessages = toChatMessages(history);

      const req: ChatRequest = {
        model: config.model,
        system: config.systemPrompt,
        messages: chatMessages,
        tools: toolDefs,
        maxTokens: 4096,
        cachePrefixMessageCount: planCachePrefix(adapter, chatMessages.length),
      };

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
            throw new Error(evt.message);
        }
      }

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
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        cachedTokensIn: usage.cachedInputTokens ?? 0,
        cost,
        purpose: "agent_turn",
      });
      await persistence.recordUsage({
        sessionId: config.sessionId,
        userId: config.userId,
        provider: adapter.id,
        model: config.model,
        purpose: "agent_turn",
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        cachedTokensIn: usage.cachedInputTokens ?? 0,
        cost,
      });
      this.emit(config.sessionId, { type: "message_saved", message: savedAssistantMsg });

      if (stopReason !== "tool_use" || toolUses.length === 0) {
        await persistence.updateSessionStatus(config.sessionId, "completed");
        await persistence.updateAgentLastStatus(config.agentId, deriveStatusLine(assistantText));
        return;
      }

      const resultBlocks: ContentBlock[] = [];
      for (const t of toolUses) {
        const input = safeJsonParse(t.inputRaw);
        this.emit(config.sessionId, { type: "tool_call", id: t.id, name: t.name, input });

        const ctx: ToolContext = {
          actor: {
            actorId: config.agentId,
            actorType: "agent",
            sessionId: config.sessionId,
            projectId: config.projectId,
            userId: config.userId,
          } satisfies ActorContext,
          rootId: config.rootId,
          pathGuard: sandbox.pathGuard,
          shellPolicy: sandbox.shellPolicy,
          audit: sandbox.audit,
          artifacts: sandbox.artifacts,
        };

        const result = await tools.run(t.name, input, ctx);
        resultBlocks.push({
          type: "tool_result",
          toolUseId: t.id,
          content: result.summary,
          isError: result.isError,
        });
        this.emit(config.sessionId, {
          type: "tool_result",
          id: t.id,
          name: t.name,
          summary: result.summary,
          isError: result.isError,
        });
      }

      await persistence.appendMessage({
        sessionId: config.sessionId,
        role: "user",
        content: resultBlocks,
        tokensIn: 0,
        tokensOut: 0,
        cachedTokensIn: 0,
        cost: 0,
        purpose: "agent_turn",
      });
    }

    await persistence.updateSessionStatus(config.sessionId, "active");
  }
}
