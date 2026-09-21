import { and, desc, eq } from "drizzle-orm";
import type { AgentLoopEvent, AgentLoopManager, PersistencePort, ProviderPort } from "@kuclab-hertz/core";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { AuditSink } from "@kuclab-hertz/sandbox";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agents, approvals, channelBindings, channelConfigs, messages, sessions } from "../db/schema.js";
import type { HertzPaths } from "../paths.js";
import type { DesktopManager } from "../computer/desktop-manager.js";
import { decryptSecret } from "../secrets/key-encryption.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";
import type { JobQueue } from "../queue/job-queue.js";
import { decideApproval } from "../tools/approval-tools.js";
import { reapExpiredApprovals } from "../tools/approval-reaper.js";
import {
  grantSessionApproval,
  normalizeApprovalSummary,
  sessionApprovalKey,
} from "../tools/session-approval-grants.js";
import { resolveVaultUseApproval } from "../tools/vault-tools.js";
import {
  executeHostAccessOp,
  formatHostAccessExecutedInbound,
  formatHostAccessRejectedInbound,
  parseHostAccessPayload,
} from "../tools/host-access-tools.js";
import { parseMcpOpPayload } from "../mcp/tool-policy.js";
import { TelegramDriver } from "./telegram.js";
import { DiscordDriver } from "./discord.js";
import type { ChannelDecision, ChannelDriver, InboundMessage, OutboundStream } from "./types.js";
import { isClearCommand, isNewChatCommand, parseDecisionCommand } from "./types.js";
import { handleTelegramCallback, handleTelegramCommand, type TelegramCommandEnv } from "./telegram-commands.js";
import { buildApprovalCard } from "./approval-card.js";
import { toolStatusLine } from "./tool-status.js";
import { stripEmoji } from "../text/strip-emoji.js";

export interface ChannelManagerDeps {
  db: Database;
  masterKey: Buffer;
  agentLoop: AgentLoopManager;
  persistence: PersistencePort;
  queue: JobQueue;
  audit: AuditSink;
  paths: HertzPaths;
  desktop: Pick<DesktopManager, "start">;
  fallbackUserId: () => Promise<string>;
  /** Provider registry for the /model picker. Optional — /model falls back to a message when absent. */
  providers?: ProviderPort;
}

interface RunningChannel {
  configId: string;
  kind: "telegram" | "discord";
  driver: ChannelDriver;
  botLabel: string;
}

interface SessionTap {
  unsubscribe: () => void;
  buffer: string;
  /** Compact Czech activity line ("Hledám na webu…") shown on live streams. */
  status: string | null;
  workingNotified: boolean;
  targets: Map<string, ChannelDriver>;
  /** Live streams per external chat — finished (not re-sent) when the turn ends. */
  streams: Map<string, OutboundStream>;
  /**
   * Serializes agent-loop events per session. Without this, a tool_call
   * immediately followed by text_delta would open two stream placeholders
   * (the second beginStream aborts the first), because updateStreams hadn't
   * cached the first stream yet.
   */
  chain: Promise<void>;
}

function parseAllowlist(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function chatPart(externalChatId: string): string {
  return externalChatId.replace(/^(telegram|discord):/, "");
}

/**
 * External chat channels: Telegram bots (long-poll) and Discord bots (gateway).
 * Each external chat maps to a regular Hertz session via channel_bindings, so
 * everything said on the phone shows up in the WebUI like any other chat —
 * and the agent's replies, questions, and approval requests flow back out.
 *
 * Telegram is a full client: the agent's reply streams into the chat with
 * throttled live edits plus a typing indicator (no "silence then wall of
 * text"), and /commands manage the agent, chats, projects, memory, skills,
 * approvals and the channel itself — in Czech, without emoji.
 */
export class ChannelManager {
  private running = new Map<string, RunningChannel>();
  private taps = new Map<string, SessionTap>();
  private started = false;
  /** Expiry sweep for approvals nobody decided in time (10 min TTL). */
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ChannelManagerDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reload();
    // Sweep promptly once at boot (a restart may have left stale pendings),
    // then every minute.
    void this.reapApprovals().catch((err) => console.warn(`[hertz] approval reaper failed: ${(err as Error).message}`));
    this.reaperTimer = setInterval(() => {
      void this.reapApprovals().catch((err) => console.warn(`[hertz] approval reaper failed: ${(err as Error).message}`));
    }, 60_000);
    this.reaperTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    for (const channel of this.running.values()) {
      try {
        channel.driver.stop();
      } catch {
        /* already down */
      }
    }
    this.running.clear();
    for (const tap of this.taps.values()) tap.unsubscribe();
    this.taps.clear();
  }

  /** Restart every channel — called after any channel config change. */
  async reload(): Promise<void> {
    for (const channel of this.running.values()) {
      try {
        channel.driver.stop();
      } catch {
        /* already down */
      }
    }
    this.running.clear();

    const configs = await this.deps.db.select().from(channelConfigs).where(eq(channelConfigs.enabled, true));
    for (const config of configs) {
      try {
        const token = decryptSecret(this.deps.masterKey, config.encryptedToken);
        const driver: ChannelDriver = config.kind === "telegram" ? new TelegramDriver(token) : new DiscordDriver(token);
        const botLabel = await driver.verify();
        await driver.start({
          onMessage: (msg) => this.handleMessage(config.id, driver, msg),
          onDecision: (externalChatId, approvalId, decision) => this.handleDecision(driver, externalChatId, approvalId, decision),
          ...(driver instanceof TelegramDriver
            ? {
                onCommandCallback: (
                  externalChatId: string,
                  action: string,
                  payload: string,
                  senderLabel: string,
                  messageId?: number,
                ) => this.handleCommandCallback(config.id, driver, externalChatId, action, payload, senderLabel, messageId),
              }
            : {}),
        });
        this.running.set(config.id, { configId: config.id, kind: config.kind, driver, botLabel });
        console.log(`[hertz] channel up: ${config.kind} "${config.label}" (${botLabel})`);
      } catch (err) {
        console.error(`[hertz] channel "${config.label}" failed to start: ${(err as Error).message}`);
      }
    }
  }

  status(): Array<{ configId: string; kind: string; botLabel: string }> {
    return [...this.running.values()].map((c) => ({ configId: c.configId, kind: c.kind, botLabel: c.botLabel }));
  }

  isRunning(configId: string): boolean {
    return this.running.has(configId);
  }

  /** Restart one channel's inbound stream (keeps the backlog); used by /restart. */
  async restartChannel(configId: string): Promise<void> {
    const channel = this.running.get(configId);
    if (!channel) throw new Error("channel not running");
    if (typeof channel.driver.restart === "function") {
      await channel.driver.restart();
    } else {
      // Drivers without restart(): full stop/start cycle via reload.
      await this.reload();
    }
  }

  /** Enable/disable a channel config and apply immediately. */
  async setChannelEnabled(configId: string, enabled: boolean): Promise<void> {
    await this.deps.db.update(channelConfigs).set({ enabled }).where(eq(channelConfigs.id, configId));
    await this.reload();
  }

  private async handleMessage(configId: string, driver: ChannelDriver, msg: InboundMessage): Promise<void> {
    const configRows = await this.deps.db.select().from(channelConfigs).where(eq(channelConfigs.id, configId)).limit(1);
    const config = configRows[0];
    if (!config || !config.enabled) return;

    const allowlist = parseAllowlist(config.allowedChatsJson);
    if (allowlist.length > 0 && !allowlist.includes(chatPart(msg.externalChatId)) && !allowlist.includes(msg.externalChatId)) {
      await driver.sendText(msg.externalChatId, "Tento chat není na allowlistu tohoto bota.").catch(() => {});
      return;
    }

    const senderAllowlist = parseAllowlist(config.allowedSendersJson);
    if (senderAllowlist.length > 0) {
      const senderKey = msg.senderId.trim();
      const labelKey = msg.senderLabel.trim();
      const bareLabel = labelKey.startsWith("@") ? labelKey.slice(1) : labelKey;
      const wanted = new Set(senderAllowlist.map((s) => s.trim()).filter(Boolean));
      const ok =
        (senderKey && (wanted.has(senderKey) || wanted.has(`${msg.externalChatId.split(":")[0]}:${senderKey}`))) ||
        wanted.has(labelKey) ||
        wanted.has(`@${bareLabel}`) ||
        wanted.has(bareLabel);
      if (!ok) {
        await driver.sendText(msg.externalChatId, "Nejsi na allowlistu odesílatelů tohoto bota.").catch(() => {});
        return;
      }
    }

    if (driver instanceof TelegramDriver) {
      // Full command surface (config, chats, memory, approvals, …) in Czech.
      if (await handleTelegramCommand(this.commandEnv(configId, driver, config), msg)) return;
    } else {
      const decision = parseDecisionCommand(msg.text);
      if (decision) {
        await this.handleDecision(driver, msg.externalChatId, decision.approvalId, decision.decision);
        return;
      }

      if (isNewChatCommand(msg.text)) {
        await this.deps.db
          .delete(channelBindings)
          .where(and(eq(channelBindings.channelId, configId), eq(channelBindings.externalChatId, msg.externalChatId)));
        await driver.sendText(msg.externalChatId, "Začínám nový chat — o čem si budeme povídat?").catch(() => {});
        return;
      }

      if (isClearCommand(msg.text)) {
        const cleared = await this.clearBoundChat(configId, msg.externalChatId);
        await driver
          .sendText(msg.externalChatId, cleared ? "Chat vymazán. Paměť, skilly a poznámky zůstávají." : "Není co mazat — tady zatím žádný aktivní chat není.")
          .catch(() => {});
        return;
      }
    }

    const content: ContentBlock[] = [{ type: "text", text: `${msg.senderLabel}: ${msg.text}` }];

    const sessionId = await this.resolveSession(driver, config, msg.externalChatId, msg.senderLabel);
    if (!sessionId) return;

    const tap = this.ensureTap(sessionId);
    tap.targets.set(msg.externalChatId, driver);

    if (this.deps.agentLoop.isRunning(sessionId)) {
      await this.deps.agentLoop.appendInbound(sessionId, content);
      return;
    }
    tap.workingNotified = false;
    await enqueueAgentRun(this.deps, { sessionId, userId: await this.deps.fallbackUserId(), userMessage: content }, { maxAttempts: 2 });
  }

  /** Per-chat command environment for the Telegram command layer. */
  private commandEnv(
    configId: string,
    driver: TelegramDriver,
    config: typeof channelConfigs.$inferSelect,
  ): TelegramCommandEnv {
    return {
      db: this.deps.db,
      masterKey: this.deps.masterKey,
      agentLoop: this.deps.agentLoop,
      paths: this.deps.paths,
      fallbackUserId: this.deps.fallbackUserId,
      configId,
      configLabel: config.label,
      driver,
      ensureSession: (externalChatId, senderLabel) => this.resolveSession(driver, config, externalChatId, senderLabel),
      boundSessionId: (externalChatId) => this.boundSessionId(configId, externalChatId),
      restartPolling: () => this.restartChannel(configId),
      setEnabled: (enabled) => this.setChannelEnabled(configId, enabled),
      clearChat: (externalChatId) => this.clearBoundChat(configId, externalChatId),
      decide: (externalChatId, approvalId, decision) => this.applyDecision(driver, externalChatId, approvalId, decision),
      pendingApprovals: (sessionId) => this.pendingApprovalsFor(sessionId),
      startDesktop: async (agentId) => {
        await this.deps.desktop.start(agentId);
      },
      botPolling: () => (typeof driver.isPolling === "function" ? driver.isPolling() : true),
      listModels: async (providerConfigId: string) => {
        if (!this.deps.providers) throw new Error("provider registry not available");
        const adapter = await this.deps.providers.getAdapter(providerConfigId);
        const models = await adapter.listModels();
        return models.map((m) => ({ id: m.id, displayName: m.displayName, contextWindow: m.contextWindow }));
      },
    };
  }

  private async handleCommandCallback(
    configId: string,
    driver: TelegramDriver,
    externalChatId: string,
    action: string,
    payload: string,
    senderLabel: string,
    messageId?: number,
  ): Promise<void> {
    const configRows = await this.deps.db.select().from(channelConfigs).where(eq(channelConfigs.id, configId)).limit(1);
    const config = configRows[0];
    if (!config || !config.enabled) return;
    await handleTelegramCallback(this.commandEnv(configId, driver, config), externalChatId, senderLabel, action, payload, messageId);
  }

  /** Bound session id without creating one. */
  private async boundSessionId(configId: string, externalChatId: string): Promise<string | undefined> {
    const bindings = await this.deps.db
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.channelId, configId), eq(channelBindings.externalChatId, externalChatId)))
      .limit(1);
    return bindings[0]?.sessionId;
  }

  private async pendingApprovalsFor(sessionId: string): Promise<
    Array<{ id: string; summary: string; detail: string | null; kind: string; payload: string | null }>
  > {
    const rows = await this.deps.db
      .select({
        id: approvals.id,
        summary: approvals.summary,
        detail: approvals.detail,
        kind: approvals.kind,
        payload: approvals.payload,
      })
      .from(approvals)
      .where(and(eq(approvals.sessionId, sessionId), eq(approvals.status, "pending")))
      .orderBy(desc(approvals.createdAt));
    return rows;
  }

  /** /clear from chat: wipe the bound session's messages (memory/skills/notes survive). */
  private async clearBoundChat(configId: string, externalChatId: string): Promise<boolean> {
    const bindings = await this.deps.db
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.channelId, configId), eq(channelBindings.externalChatId, externalChatId)))
      .limit(1);
    const binding = bindings[0];
    if (!binding) return false;
    await this.deps.db.delete(messages).where(eq(messages.sessionId, binding.sessionId));
    await this.deps.db
      .update(sessions)
      .set({ status: "active", metadata: null, updatedAt: new Date() })
      .where(eq(sessions.id, binding.sessionId));
    return true;
  }

  private async resolveSession(
    driver: ChannelDriver,
    config: typeof channelConfigs.$inferSelect,
    externalChatId: string,
    senderLabel: string,
  ): Promise<string | undefined> {
    const bindings = await this.deps.db
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.channelId, config.id), eq(channelBindings.externalChatId, externalChatId)))
      .limit(1);
    if (bindings[0]) {
      const sessionRows = await this.deps.db.select().from(sessions).where(eq(sessions.id, bindings[0].sessionId)).limit(1);
      const session = sessionRows[0];
      if (session && session.status !== "archived") {
        const agentRows = await this.deps.db.select().from(agents).where(eq(agents.id, session.agentId)).limit(1);
        const agent = agentRows[0];
        if (agent) return session.id;
      }
      await this.deps.db.delete(channelBindings).where(eq(channelBindings.id, bindings[0].id));
    }

    if (!config.defaultAgentId) {
      await driver.sendText(externalChatId, "Pro tohoto bota není nastavený výchozí agent — nejdřív ho vyber na stránce Kanály.").catch(() => {});
      return undefined;
    }
    const agentRows = await this.deps.db.select().from(agents).where(eq(agents.id, config.defaultAgentId)).limit(1);
    const agent = agentRows[0];
    if (!agent) {
      await driver.sendText(externalChatId, "Výchozí agent tohoto bota není dostupný — vyber jiného na stránce Kanály.").catch(() => {});
      return undefined;
    }

    const now = new Date();
    const sessionId = newId();
    await this.deps.db.insert(sessions).values({
      id: sessionId,
      agentId: agent.id,
      projectId: agent.projectId,
      title: `${senderLabel} (${config.kind})`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await this.deps.db
      .insert(channelBindings)
      .values({ id: newId(), channelId: config.id, externalChatId, sessionId, createdAt: now })
      .onConflictDoNothing();
    return sessionId;
  }

  private ensureTap(sessionId: string): SessionTap {
    const existing = this.taps.get(sessionId);
    if (existing) return existing;
    const tap: SessionTap = {
      buffer: "",
      status: null,
      workingNotified: false,
      targets: new Map(),
      streams: new Map(),
      chain: Promise.resolve(),
      unsubscribe: () => {},
    };
    tap.unsubscribe = this.deps.agentLoop.subscribe(sessionId, (event) => {
      // Queue behind the previous event — never process two events for the
      // same session concurrently (see SessionTap.chain).
      tap.chain = tap.chain
        .then(() => this.handleLoopEvent(sessionId, tap, event))
        .catch((err) => console.warn(`[hertz] channel tap failed: ${(err as Error).message}`));
    });
    this.taps.set(sessionId, tap);
    return tap;
  }

  private async handleLoopEvent(sessionId: string, tap: SessionTap, event: AgentLoopEvent): Promise<void> {
    if (event.type === "text_delta" && event.text) {
      tap.buffer += event.text;
      await this.updateStreams(tap);
      return;
    }
    if (event.type === "tool_call") {
      // Open the live stream eagerly so the user sees activity immediately,
      // not after the first tool round finishes. The stream shows a compact
      // Czech status line for the tool — never a raw tool-call dump.
      tap.status = toolStatusLine(event.name, event.input);
      await this.updateStreams(tap);
      for (const [chatId, driver] of tap.targets) {
        if (typeof driver.beginStream === "function") {
          await driver.typing?.(chatId).catch(() => {});
        } else if (!tap.workingNotified && !tap.buffer.trim()) {
          tap.workingNotified = true;
          await driver.sendText(chatId, "Pracuji na tom…").catch(() => {});
        }
      }
      return;
    }
    if (event.type === "tool_result") {
      // The tool finished — the status line described "right now", so clear
      // it; the next tool_call (or the final text) takes over.
      if (tap.status !== null) {
        tap.status = null;
        for (const [chatId] of tap.targets) {
          const stream = tap.streams.get(chatId);
          if (stream?.setStatus) await stream.setStatus(null).catch(() => {});
        }
      }
      // Long tool runs: keep the typing bubble alive on streaming targets.
      for (const [chatId, driver] of tap.targets) {
        if (typeof driver.beginStream === "function") {
          await driver.typing?.(chatId).catch(() => {});
        }
      }
      return;
    }
    if (event.type === "file_sent") {
      // The agent delivered a file to the user — forward the bytes to every
      // channel target that can carry documents (Telegram sendDocument).
      for (const [chatId, driver] of tap.targets) {
        if (typeof driver.sendDocument === "function") {
          await driver
            .sendDocument(chatId, {
              absolutePath: event.attachment.absolutePath,
              filename: event.attachment.filename,
              caption: event.attachment.caption,
            })
            .catch((err) => console.warn(`[hertz] channel sendDocument failed: ${(err as Error).message}`));
        }
      }
      return;
    }
    if (event.type === "awaiting_input") {
      await this.finishStreams(tap);
      const pendingApprovalId = await this.pendingApprovalId(sessionId);
      if (pendingApprovalId) {
        const rows = await this.deps.db.select().from(approvals).where(eq(approvals.id, pendingApprovalId)).limit(1);
        const approval = rows[0];
        if (approval && approval.status === "pending") {
          const card = buildApprovalCard({
            summary: stripEmoji(approval.summary),
            detail: approval.detail ? stripEmoji(approval.detail) : null,
            kind: approval.kind,
            payload: approval.payload,
          });
          for (const [chatId, driver] of tap.targets) {
            await driver.sendApproval(chatId, approval.id, card).catch((err) =>
              console.warn(`[hertz] channel send failed: ${(err as Error).message}`),
            );
          }
          return;
        }
      }
      if (event.question) await this.broadcast(tap, event.question);
      return;
    }
    if (event.type === "error") {
      await this.finishStreams(tap);
      await this.broadcastSystem(tap, event.message ?? "Něco se pokazilo.");
      this.dropTap(sessionId);
      return;
    }
    if (event.type === "done") {
      const hadText = tap.buffer.trim().length > 0;
      await this.finishStreams(tap);
      if (!hadText) {
        // Tool-only run with no closing words — deliver the last assistant text from history instead of silence.
        const fallback = await this.lastAssistantText(sessionId);
        if (fallback) await this.broadcast(tap, fallback);
      }
      this.dropTap(sessionId);
    }
  }

  /**
   * Push the current draft into every streaming target (throttled by the
   * driver). Targets without streaming keep accumulating into the buffer and
   * get one final sendText — the old behavior.
   */
  private async updateStreams(tap: SessionTap): Promise<void> {
    for (const [chatId, driver] of tap.targets) {
      if (typeof driver.beginStream !== "function") continue;
      let stream = tap.streams.get(chatId);
      if (!stream) {
        const opened = await driver.beginStream(chatId, tap.buffer).catch(() => undefined);
        if (!opened) continue; // placeholder failed — legacy sendText fallback
        tap.streams.set(chatId, opened);
        stream = opened;
      }
      await stream.update(tap.buffer).catch(() => {});
      if (stream.setStatus) await stream.setStatus(tap.status).catch(() => {});
    }
  }

  /**
   * Finalize every open stream in place (no duplicate message) and flush the
   * buffer to legacy targets. Consumes the buffer.
   */
  private async finishStreams(tap: SessionTap): Promise<void> {
    // Conversational text — emoji pass through untouched (sparing use is allowed).
    const text = tap.buffer.trim();
    tap.buffer = "";
    for (const [chatId, driver] of tap.targets) {
      const stream = tap.streams.get(chatId);
      tap.streams.delete(chatId);
      if (stream) {
        await stream.finish(text).catch(() => {});
      } else if (text) {
        await driver.sendText(chatId, text).catch((err) => console.warn(`[hertz] channel send failed: ${(err as Error).message}`));
      }
    }
  }

  private dropTap(sessionId: string): void {
    const tap = this.taps.get(sessionId);
    if (tap) {
      for (const stream of tap.streams.values()) {
        void stream.abort().catch(() => {});
      }
      tap.streams.clear();
      tap.unsubscribe();
      this.taps.delete(sessionId);
    }
  }

  /** Broadcast conversational assistant text (ask_user question, history fallback) — emoji are allowed. */
  private async broadcast(tap: SessionTap, text: string): Promise<void> {
    for (const [chatId, driver] of tap.targets) {
      await driver.sendText(chatId, text).catch((err) => console.warn(`[hertz] channel send failed: ${(err as Error).message}`));
    }
  }

  /** Broadcast a system message (e.g. an error) — UI text, so emoji are stripped. */
  private async broadcastSystem(tap: SessionTap, text: string): Promise<void> {
    const clean = stripEmoji(text);
    for (const [chatId, driver] of tap.targets) {
      await driver.sendText(chatId, clean).catch((err) => console.warn(`[hertz] channel send failed: ${(err as Error).message}`));
    }
  }

  private async pendingApprovalId(sessionId: string): Promise<string | undefined> {
    const rows = await this.deps.db.select({ metadata: sessions.metadata }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    try {
      const meta = rows[0]?.metadata ? (JSON.parse(rows[0].metadata) as Record<string, unknown>) : {};
      return typeof meta.pendingApprovalId === "string" ? meta.pendingApprovalId : undefined;
    } catch {
      return undefined;
    }
  }

  private async lastAssistantText(sessionId: string): Promise<string> {
    try {
      const history = await this.deps.persistence.listMessages(sessionId);
      for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i]!;
        if (message.role !== "assistant") continue;
        const text = message.content
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) return text;
      }
    } catch {
      /* fall through */
    }
    return "";
  }

  private async handleDecision(
    driver: ChannelDriver,
    externalChatId: string,
    approvalId: string,
    decision: ChannelDecision,
  ): Promise<void> {
    const reply = await this.applyDecision(driver, externalChatId, approvalId, decision);
    await driver
      .sendText(externalChatId, reply ?? "Toto schválení už nečeká (bylo rozhodnuto nebo vypršelo).")
      .catch(() => {});
  }

  /**
   * Stable grant key for "Povolit pro session": the approval kind plus a
   * tool-specific stable scope, so only the same action is pre-approved —
   * never a blanket pass for everything.
   */
  private sessionGrantKeyFor(result: { kind: string; payload: string | null; summary: string }): string | undefined {
    switch (result.kind) {
      case "host_access": {
        const payload = parseHostAccessPayload(result.payload);
        return payload ? sessionApprovalKey("host_access", `${payload.op}:${payload.hostPath}`) : undefined;
      }
      case "vault_use": {
        try {
          const parsed = JSON.parse(result.payload ?? "") as { credentialId?: unknown };
          return typeof parsed?.credentialId === "string"
            ? sessionApprovalKey("vault_use", parsed.credentialId)
            : undefined;
        } catch {
          return undefined;
        }
      }
      case "mcp_op": {
        const payload = parseMcpOpPayload(result.payload);
        return payload ? sessionApprovalKey("mcp_op", `${payload.serverId}:${payload.toolName}`) : undefined;
      }
      default:
        return sessionApprovalKey("generic", normalizeApprovalSummary(result.summary));
    }
  }

  /**
   * Resolve an approval exactly like the WebUI inbox does and resume the
   * session. Returns the user-facing reply text, or undefined when the
   * approval is no longer pending. Kind-agnostic: works for generic,
   * host_access, and any future approval kinds (e.g. vault_use) — the kind
   * only decides whether the server executes an op after approval.
   */
  private async applyDecision(
    driver: ChannelDriver,
    externalChatId: string,
    approvalId: string,
    decision: ChannelDecision,
  ): Promise<string | undefined> {
    const ownerId = await this.deps.fallbackUserId();
    // "approved-session" resolves as a normal approval; the session grant is
    // recorded separately below so the next identical request skips the gate.
    const effectiveDecision = decision === "rejected" ? "rejected" : "approved";
    const result = await decideApproval(this.deps.db, approvalId, effectiveDecision, ownerId);
    if (!result) return undefined;

    if (decision === "approved-session") {
      const key = this.sessionGrantKeyFor(result);
      if (key) grantSessionApproval(result.sessionId, key, ownerId);
      await this.deps.audit
        .record({
          actorId: ownerId,
          actorType: "user",
          sessionId: result.sessionId,
          projectId: result.projectId,
          action: "approval.session_grant",
          target: approvalId,
          targetType: "approval",
          result: "allowed",
          detail: { kind: result.kind, summary: result.summary, via: "channel" },
        });
    }

    // Host-access approvals decided from chat execute the op the same way as
    // the WebUI inbox does — the agent must never be told "approved" without
    // the server having performed the op.
    let inboundText: string;
    if (result.kind === "host_access") {
      const payload = parseHostAccessPayload(result.payload);
      if (!payload) {
        inboundText = `[Your host-access request "${result.summary}" (via chat channel) had an unreadable payload — the server could not execute it. Continue inside your own files.]`;
      } else if (effectiveDecision === "rejected") {
        await this.deps.audit.record({
          actorId: ownerId,
          actorType: "user",
          sessionId: result.sessionId,
          projectId: result.projectId,
          action: "host_access.rejected",
          target: payload.hostPath,
          targetType: "host_path",
          result: "denied",
          detail: { op: payload.op, hostPath: payload.hostPath, approvalId, via: "channel" },
        });
        inboundText = formatHostAccessRejectedInbound(payload);
      } else {
        await this.deps.audit.record({
          actorId: ownerId,
          actorType: "user",
          sessionId: result.sessionId,
          projectId: result.projectId,
          action: "host_access.approved",
          target: payload.hostPath,
          targetType: "host_path",
          result: "allowed",
          detail: { op: payload.op, hostPath: payload.hostPath, approvalId, via: "channel" },
        });
        const opResult = await executeHostAccessOp(payload);
        await this.deps.db.update(approvals).set({ result: JSON.stringify(opResult) }).where(eq(approvals.id, approvalId));
        await this.deps.audit.record({
          actorId: ownerId,
          actorType: "user",
          sessionId: result.sessionId,
          projectId: result.projectId,
          action: "host_access.executed",
          target: payload.hostPath,
          targetType: "host_path",
          result: opResult.ok ? "allowed" : "error",
          detail: { op: payload.op, hostPath: payload.hostPath, ok: opResult.ok, bytes: opResult.bytes, error: opResult.error, via: "channel" },
        });
        inboundText = formatHostAccessExecutedInbound(payload, opResult);
      }
    } else if (result.kind === "vault_use") {
      // Same as the WebUI inbox: approving mints a single-use, session-scoped,
      // 5-minute in-memory grant — the secret never lands in the DB, logs,
      // or chat history. Rejecting issues nothing.
      inboundText = await resolveVaultUseApproval(this.deps.db, this.deps.masterKey, {
        approvalId,
        sessionId: result.sessionId,
        summary: result.summary,
        payload: result.payload,
        decision: effectiveDecision,
        decidedByUserId: ownerId,
      });
    } else {
      inboundText =
        effectiveDecision === "approved"
          ? `[The user APPROVED your request "${result.summary}" (via chat channel).] Proceed exactly as described.`
          : `[The user REJECTED your request "${result.summary}" (via chat channel).] Do not perform it. Continue without it — propose an alternative only if it's essential to the task.`;
    }

    await this.deps.agentLoop.appendInbound(result.sessionId, [
      {
        type: "text",
        text: inboundText,
      },
    ]);
    const metaRows = await this.deps.db.select({ metadata: sessions.metadata }).from(sessions).where(eq(sessions.id, result.sessionId)).limit(1);
    let meta: Record<string, unknown> = {};
    try {
      meta = metaRows[0]?.metadata ? (JSON.parse(metaRows[0].metadata) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    delete meta.pendingQuestion;
    delete meta.pendingApprovalId;
    await this.deps.db
      .update(sessions)
      .set({ status: "active", metadata: JSON.stringify(meta), updatedAt: new Date() })
      .where(eq(sessions.id, result.sessionId));

    const tap = this.ensureTap(result.sessionId);
    tap.targets.set(externalChatId, driver);
    tap.workingNotified = false;
    try {
      await enqueueAgentRun(this.deps, { sessionId: result.sessionId, prePersisted: true }, { maxAttempts: 2 });
    } catch {
      // Session already running — the inbound decision above is picked up mid-run.
    }

    return decision === "approved"
      ? `Schváleno: ${result.summary}`
      : decision === "approved-session"
        ? `Schváleno pro tuto session: ${result.summary}`
        : `Zamítnuto: ${result.summary}`;
  }

  /**
   * Expiry sweep: approvals nobody decided within the TTL are treated as
   * rejected — the parked session resumes with an expiry notice and every
   * bound chat gets a short heads-up. Runs every minute from start().
   */
  private async reapApprovals(): Promise<void> {
    const expired = await reapExpiredApprovals(this.deps.db);
    if (expired.length === 0) return;
    const ownerId = await this.deps.fallbackUserId().catch(() => "");
    for (const item of expired) {
      await this.deps.audit
        .record({
          actorId: ownerId,
          actorType: "user",
          sessionId: item.sessionId,
          action: "approval.expired",
          target: item.id,
          targetType: "approval",
          result: "denied",
          detail: { summary: item.summary },
        });

      // Drop the parked "waiting for decision" state.
      try {
        const metaRows = await this.deps.db
          .select({ metadata: sessions.metadata })
          .from(sessions)
          .where(eq(sessions.id, item.sessionId))
          .limit(1);
        let meta: Record<string, unknown> = {};
        try {
          meta = metaRows[0]?.metadata ? (JSON.parse(metaRows[0].metadata) as Record<string, unknown>) : {};
        } catch {
          meta = {};
        }
        delete meta.pendingQuestion;
        delete meta.pendingApprovalId;
        await this.deps.db
          .update(sessions)
          .set({ status: "active", metadata: JSON.stringify(meta), updatedAt: new Date() })
          .where(eq(sessions.id, item.sessionId));
      } catch {
        /* the resume below still informs the agent */
      }

      await this.deps.agentLoop
        .appendInbound(item.sessionId, [
          {
            type: "text",
            text: `[Požadavek na schválení „${item.summary}" vypršel bez rozhodnutí — beru ho jako ZAMÍTNUTÝ. Neprováděj ho a nepokoušej se ho obejít; pokračuj bez něj.]`,
          },
        ])
        .catch(() => {});

      // Notify every chat bound to the session.
      const tap = this.ensureTap(item.sessionId);
      try {
        const bindings = await this.deps.db
          .select({ channelId: channelBindings.channelId, externalChatId: channelBindings.externalChatId })
          .from(channelBindings)
          .where(eq(channelBindings.sessionId, item.sessionId));
        for (const binding of bindings) {
          const channel = this.running.get(binding.channelId);
          if (!channel) continue;
          tap.targets.set(binding.externalChatId, channel.driver);
          await channel.driver
            .sendText(binding.externalChatId, `Schválení vypršelo bez rozhodnutí — beru to jako zamítnutí: ${item.summary}`)
            .catch(() => {});
        }
      } catch {
        /* notification is best-effort */
      }

      try {
        await enqueueAgentRun(this.deps, { sessionId: item.sessionId, prePersisted: true }, { maxAttempts: 2 });
      } catch {
        // Session already running — the inbound expiry notice is picked up mid-run.
      }
    }
  }

  /** Recent channel-linked chats for the Channels page. */
  async recentBindings(limit = 30): Promise<
    Array<{ id: string; channelId: string; externalChatId: string; sessionId: string; projectId: string | null; sessionTitle: string | null; createdAt: Date }>
  > {
    const rows = await this.deps.db
      .select({
        id: channelBindings.id,
        channelId: channelBindings.channelId,
        externalChatId: channelBindings.externalChatId,
        sessionId: channelBindings.sessionId,
        projectId: sessions.projectId,
        sessionTitle: sessions.title,
        createdAt: channelBindings.createdAt,
      })
      .from(channelBindings)
      .leftJoin(sessions, eq(channelBindings.sessionId, sessions.id))
      .orderBy(desc(channelBindings.createdAt))
      .limit(limit);
    return rows.map((r) => ({ ...r, projectId: r.projectId ?? null, sessionTitle: r.sessionTitle ?? null }));
  }

}
