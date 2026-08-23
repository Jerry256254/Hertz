import { and, eq } from "drizzle-orm";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { PersistedMessage } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agents, channelBindings, channelConfigs, sessions, users } from "../db/schema.js";
import { createPersistenceAdapter } from "../persistence/persistence-adapter.js";
import type { JobQueue } from "../queue/job-queue.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";
import { TelegramGateway } from "./telegram-gateway.js";

export interface ChannelManagerDeps {
  db: Database;
  queue: JobQueue;
  masterKey: Buffer;
  decrypt: (masterKey: Buffer, serialized: string) => string;
  /** Fallback attribution for usage records when no better user is known. */
  fallbackUserId: () => Promise<string>;
}

interface RunningChannel {
  configId: string;
  stop: () => void;
}

/**
 * Owns one live gateway per enabled channel config. Inbound chat messages are
 * routed to (or create) a bound session and enqueued as agent runs; once the
 * run finishes, the agent's final reply is delivered back into the same chat.
 * The browser tab becomes optional — you run your bots from your phone.
 */
export class ChannelManager {
  private readonly running = new Map<string, RunningChannel>();

  constructor(private readonly deps: ChannelManagerDeps) {
    this.persistence = createPersistenceAdapter(deps.db);
  }

  private readonly persistence: ReturnType<typeof createPersistenceAdapter>;

  async start(): Promise<void> {
    const configs = await this.deps.db.select().from(channelConfigs).where(eq(channelConfigs.enabled, true));
    for (const config of configs) {
      this.startOne(config.id).catch(() => {});
    }
  }

  stopAll(): void {
    for (const entry of this.running.values()) entry.stop();
    this.running.clear();
  }

  isLive(configId: string): boolean {
    return this.running.has(configId);
  }

  stopOne(configId: string): void {
    this.running.get(configId)?.stop();
    this.running.delete(configId);
  }

  /** Restarts (or stops) one config's gateway after CRUD changes. */
  async restart(configId: string): Promise<void> {
    this.running.get(configId)?.stop();
    this.running.delete(configId);
    const rows = await this.deps.db.select().from(channelConfigs).where(eq(channelConfigs.id, configId)).limit(1);
    const config = rows[0];
    if (config?.enabled) await this.startOne(configId);
  }

  private async startOne(configId: string): Promise<void> {
    if (this.running.has(configId)) return;
    const rows = await this.deps.db.select().from(channelConfigs).where(eq(channelConfigs.id, configId)).limit(1);
    const config = rows[0];
    if (!config || !config.enabled) return;

    const token = this.deps.decrypt(this.deps.masterKey, config.encryptedToken);
    const logger = {
      info: (msg: string) => console.log(`[channel ${config.kind}/${config.label}] ${msg}`),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[channel ${config.kind}/${config.label}] ${msg}`, ...args),
    };

    let stop = () => {};
    if (config.kind === "telegram") {
      const gateway = new TelegramGateway(token, logger, async (ctx) => {
        await this.handleInbound(config.id, `telegram:${ctx.chatId}`, ctx.text, (replyText) => ctx.reply(replyText));
      });
      void gateway.runLoop();
      stop = () => gateway.stop();
    } else {
      // Discord was removed — configs left over from older versions are ignored.
      logger.warn(`channel kind "${config.kind}" is not supported anymore; skipping`);
      return;
    }

    this.running.set(configId, { configId, stop });
  }

  private async allowed(config: typeof channelConfigs.$inferSelect, externalChatId: string): Promise<boolean> {
    if (!config.allowedChatsJson) return true; // open by default for DMs; set an allowlist in production
    try {
      const list = JSON.parse(config.allowedChatsJson) as string[];
      return list.length === 0 || list.includes(externalChatId);
    } catch {
      return false;
    }
  }

  private async handleInbound(
    channelId: string,
    externalChatId: string,
    text: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const { db, queue } = this.deps;

    const configRows = await db.select().from(channelConfigs).where(eq(channelConfigs.id, channelId)).limit(1);
    const config = configRows[0];
    if (!config || !config.enabled) return;
    if (!(await this.allowed(config, externalChatId))) return;

    // Route to the bound session, or bind a fresh one on the default agent.
    const bindingRows = await db
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.channelId, channelId), eq(channelBindings.externalChatId, externalChatId)))
      .limit(1);

    let sessionId = bindingRows[0]?.sessionId;

    if (!sessionId) {
      if (!config.defaultAgentId) {
        await reply("No default agent is configured for this bot yet — set one in Hertz → Kanály.");
        return;
      }
      const agentRows = await db.select().from(agents).where(eq(agents.id, config.defaultAgentId)).limit(1);
      const agent = agentRows[0];
      if (!agent || agent.approvalStatus !== "approved" || agent.status === "terminated") {
        await reply("The default agent for this bot isn't available right now.");
        return;
      }

      sessionId = newId();
      const now = new Date();
      await db.insert(sessions).values({
        id: sessionId,
        agentId: agent.id,
        projectId: agent.projectId,
        title: `${config.label} — ${externalChatId.split(":").pop()}`,
        mode: "autonomous",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(channelBindings).values({
        id: newId(),
        channelId,
        externalChatId,
        sessionId,
        createdAt: now,
      });
    }

    // The loop merges this into a running turn automatically; otherwise the
    // queued run answers it. Either way, deliver the final assistant message
    // back into the chat when the job completes.
    const jobId = await enqueueAgentRun(
      { queue },
      {
        sessionId,
        userId: await fallbackAttribution(db),
        prePersisted: false,
        userMessage: [{ type: "text", text: `[Message from your connected chat — reply normally; it will be delivered back]\n\n${text}` }],
        suppressAutoMemory: false,
      },
      { maxAttempts: 2 },
    );

    void this.deliverReplyWhenDone(jobId, sessionId, reply);
  }

  private async deliverReplyWhenDone(jobId: string, sessionId: string, reply: (text: string) => Promise<void>): Promise<void> {
    try {
      await this.deps.queue.whenDone(jobId);
    } catch {
      await reply("(The agent hit an error while working on that.)");
      return;
    }
    // Wait out the appendInbound merge window: if the session was mid-run, our
    // message rides along and the run finishes a bit later than the job row.
    const history: PersistedMessage[] = await this.persistence.listMessages(sessionId);
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant" && !m.senderAgentId);
    const text = (lastAssistant?.content ?? [])
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return;
    if (/^\(idle\)$/.test(text)) return; // heartbeat-style no-op stays silent
    try {
      await reply(text);
    } catch (err) {
      console.warn("[channels] failed to deliver reply:", (err as Error).message);
    }
  }
}

async function fallbackAttribution(db: ChannelManagerDeps["db"]): Promise<string> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows[0]?.id ?? "";
}
