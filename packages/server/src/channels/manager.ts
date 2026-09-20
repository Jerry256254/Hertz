import { and, desc, eq } from "drizzle-orm";
import type { AgentLoopEvent, AgentLoopManager, PersistencePort } from "@kuclab-hertz/core";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { AuditSink } from "@kuclab-hertz/sandbox";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agents, approvals, channelBindings, channelConfigs, messages, sessions } from "../db/schema.js";
import { decryptSecret } from "../secrets/key-encryption.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";
import type { JobQueue } from "../queue/job-queue.js";
import { decideApproval } from "../tools/approval-tools.js";
import {
  executeHostAccessOp,
  formatHostAccessExecutedInbound,
  formatHostAccessRejectedInbound,
  parseHostAccessPayload,
} from "../tools/host-access-tools.js";
import { TelegramDriver } from "./telegram.js";
import { DiscordDriver } from "./discord.js";
import type { ChannelDriver, InboundMessage } from "./types.js";
import { isClearCommand, isNewChatCommand, parseDecisionCommand } from "./types.js";

export interface ChannelManagerDeps {
  db: Database;
  masterKey: Buffer;
  agentLoop: AgentLoopManager;
  persistence: PersistencePort;
  queue: JobQueue;
  audit: AuditSink;
  fallbackUserId: () => Promise<string>;
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
  workingNotified: boolean;
  targets: Map<string, ChannelDriver>;
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
 */
export class ChannelManager {
  private running = new Map<string, RunningChannel>();
  private taps = new Map<string, SessionTap>();
  private started = false;

  constructor(private readonly deps: ChannelManagerDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reload();
  }

  stop(): void {
    this.started = false;
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

  private async handleMessage(configId: string, driver: ChannelDriver, msg: InboundMessage): Promise<void> {
    const configRows = await this.deps.db.select().from(channelConfigs).where(eq(channelConfigs.id, configId)).limit(1);
    const config = configRows[0];
    if (!config || !config.enabled) return;

    const allowlist = parseAllowlist(config.allowedChatsJson);
    if (allowlist.length > 0 && !allowlist.includes(chatPart(msg.externalChatId)) && !allowlist.includes(msg.externalChatId)) {
      await driver.sendText(msg.externalChatId, "This chat isn't on this bot's allowlist.").catch(() => {});
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
        await driver.sendText(msg.externalChatId, "You're not on this bot's sender allowlist.").catch(() => {});
        return;
      }
    }

    const decision = parseDecisionCommand(msg.text);
    if (decision) {
      await this.handleDecision(driver, msg.externalChatId, decision.approvalId, decision.decision);
      return;
    }

    if (isNewChatCommand(msg.text)) {
      await this.deps.db
        .delete(channelBindings)
        .where(and(eq(channelBindings.channelId, configId), eq(channelBindings.externalChatId, msg.externalChatId)));
      await driver.sendText(msg.externalChatId, "New chat started — what should we work on?").catch(() => {});
      return;
    }

    if (isClearCommand(msg.text)) {
      const cleared = await this.clearBoundChat(configId, msg.externalChatId);
      await driver
        .sendText(msg.externalChatId, cleared ? "Chat cleared. Memory, skills and notes are untouched." : "Nothing to clear — no active chat here yet.")
        .catch(() => {});
      return;
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
      await driver.sendText(externalChatId, "No default agent is set for this bot — configure one on the Channels page first.").catch(() => {});
      return undefined;
    }
    const agentRows = await this.deps.db.select().from(agents).where(eq(agents.id, config.defaultAgentId)).limit(1);
    const agent = agentRows[0];
    if (!agent) {
      await driver.sendText(externalChatId, "The default agent for this bot is unavailable — pick another one on the Channels page.").catch(() => {});
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
      workingNotified: false,
      targets: new Map(),
      unsubscribe: () => {},
    };
    tap.unsubscribe = this.deps.agentLoop.subscribe(sessionId, (event) => {
      void this.handleLoopEvent(sessionId, tap, event).catch((err) =>
        console.warn(`[hertz] channel tap failed: ${(err as Error).message}`),
      );
    });
    this.taps.set(sessionId, tap);
    return tap;
  }

  private async handleLoopEvent(sessionId: string, tap: SessionTap, event: AgentLoopEvent): Promise<void> {
    if (event.type === "text_delta" && event.text) {
      tap.buffer += event.text;
      return;
    }
    if (event.type === "tool_call") {
      if (!tap.workingNotified && !tap.buffer.trim()) {
        tap.workingNotified = true;
        await this.broadcast(tap, "Working on it…");
      }
      return;
    }
    if (event.type === "awaiting_input") {
      await this.flush(tap);
      const pendingApprovalId = await this.pendingApprovalId(sessionId);
      if (pendingApprovalId) {
        const rows = await this.deps.db.select().from(approvals).where(eq(approvals.id, pendingApprovalId)).limit(1);
        const approval = rows[0];
        if (approval && approval.status === "pending") {
          for (const [chatId, driver] of tap.targets) {
            await driver.sendApproval(chatId, approval.id, approval.summary, approval.detail).catch((err) =>
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
      await this.flush(tap);
      await this.broadcast(tap, event.message ?? "Something went wrong.");
      this.dropTap(sessionId);
      return;
    }
    if (event.type === "done") {
      const hadText = tap.buffer.trim().length > 0;
      await this.flush(tap);
      if (!hadText) {
        // Tool-only run with no closing words — deliver the last assistant text from history instead of silence.
        const fallback = await this.lastAssistantText(sessionId);
        if (fallback) await this.broadcast(tap, fallback);
      }
      this.dropTap(sessionId);
    }
  }

  private dropTap(sessionId: string): void {
    const tap = this.taps.get(sessionId);
    if (tap) {
      tap.unsubscribe();
      this.taps.delete(sessionId);
    }
  }

  private async flush(tap: SessionTap): Promise<void> {
    const text = tap.buffer.trim();
    tap.buffer = "";
    if (text) await this.broadcast(tap, text);
  }

  private async broadcast(tap: SessionTap, text: string): Promise<void> {
    for (const [chatId, driver] of tap.targets) {
      await driver.sendText(chatId, text).catch((err) => console.warn(`[hertz] channel send failed: ${(err as Error).message}`));
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
    decision: "approved" | "rejected",
  ): Promise<void> {
    const ownerId = await this.deps.fallbackUserId();
    const result = await decideApproval(this.deps.db, approvalId, decision, ownerId);
    if (!result) {
      await driver.sendText(externalChatId, "That approval is no longer pending (already decided or expired).").catch(() => {});
      return;
    }

    // Host-access approvals decided from chat execute the op the same way as
    // the WebUI inbox does — the agent must never be told "approved" without
    // the server having performed the op.
    let inboundText: string;
    if (result.kind === "host_access") {
      const payload = parseHostAccessPayload(result.payload);
      if (!payload) {
        inboundText = `[Your host-access request "${result.summary}" (via chat channel) had an unreadable payload — the server could not execute it. Continue inside your own files.]`;
      } else if (decision === "rejected") {
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
    } else {
      inboundText =
        decision === "approved"
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

    await driver
      .sendText(externalChatId, decision === "approved" ? `Approved: ${result.summary}` : `Rejected: ${result.summary}`)
      .catch(() => {});
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
