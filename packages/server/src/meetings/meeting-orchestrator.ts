import { EventEmitter } from "node:events";
import { asc, eq } from "drizzle-orm";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { ProviderPort } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agents, meetingMessages, meetingParticipants, meetings, usageRecords } from "../db/schema.js";
import { buildSystemPrompt } from "../agents/system-prompt.js";

export interface MeetingChatMessage {
  id: string;
  meetingId: string;
  senderAgentId: string | null;
  content: ContentBlock[];
  createdAt: Date;
}

export type MeetingEvent =
  | { type: "message"; message: MeetingChatMessage }
  | { type: "turn_started"; agentId: string; agentName: string }
  | { type: "error"; message: string }
  | { type: "done" };

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Runs one round of a meeting: every participant takes a single conversational
 * turn, in participant order, seeing the transcript so far (including turns
 * taken earlier in this same round). Deliberately not a full tool-using agent
 * loop — a meeting is participants talking, not each of them working — so this
 * stays fast and side-effect-free; real work still happens via assign_task or a
 * direct 1:1 session with that employee.
 */
export class MeetingOrchestrator {
  private readonly emitters = new Map<string, EventEmitter>();
  private readonly running = new Set<string>();

  constructor(private readonly deps: { db: Database; providers: ProviderPort; userId: () => Promise<string> }) {}

  isRunning(meetingId: string): boolean {
    return this.running.has(meetingId);
  }

  subscribe(meetingId: string, listener: (event: MeetingEvent) => void): () => void {
    const emitter = this.getEmitter(meetingId);
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  }

  private getEmitter(meetingId: string): EventEmitter {
    let emitter = this.emitters.get(meetingId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(50);
      this.emitters.set(meetingId, emitter);
    }
    return emitter;
  }

  private emit(meetingId: string, event: MeetingEvent): void {
    this.getEmitter(meetingId).emit("event", event);
  }

  async appendUserMessage(meetingId: string, text: string): Promise<MeetingChatMessage> {
    const id = newId();
    const createdAt = new Date();
    const content: ContentBlock[] = [{ type: "text", text }];
    await this.deps.db.insert(meetingMessages).values({
      id,
      meetingId,
      senderAgentId: null,
      content: JSON.stringify(content),
      createdAt,
    });
    await this.deps.db.update(meetings).set({ updatedAt: createdAt }).where(eq(meetings.id, meetingId));
    const message: MeetingChatMessage = { id, meetingId, senderAgentId: null, content, createdAt };
    this.emit(meetingId, { type: "message", message });
    return message;
  }

  /** Kicks off a background round; does not block the HTTP request that triggered it. */
  startRound(meetingId: string): void {
    if (this.running.has(meetingId)) return;
    this.running.add(meetingId);
    void this.runRound(meetingId)
      .catch((err) => this.emit(meetingId, { type: "error", message: (err as Error).message }))
      .finally(() => {
        this.running.delete(meetingId);
        this.emit(meetingId, { type: "done" });
      });
  }

  private async buildTranscript(meetingId: string): Promise<string> {
    const rows = await this.deps.db
      .select()
      .from(meetingMessages)
      .where(eq(meetingMessages.meetingId, meetingId))
      .orderBy(asc(meetingMessages.createdAt));
    const agentRows = await this.deps.db.select().from(agents);
    const nameById = new Map(agentRows.map((a) => [a.id, a]));

    return rows
      .map((row) => {
        const content = JSON.parse(row.content) as ContentBlock[];
        const speaker = row.senderAgentId ? nameById.get(row.senderAgentId) : undefined;
        const label = row.senderAgentId ? (speaker ? `${speaker.name} (${speaker.role})` : "Former teammate") : "User";
        return `${label}: ${textOf(content)}`;
      })
      .join("\n\n");
  }

  private async runRound(meetingId: string): Promise<void> {
    const { db, providers } = this.deps;
    const participantRows = await db
      .select({ agent: agents })
      .from(meetingParticipants)
      .innerJoin(agents, eq(meetingParticipants.agentId, agents.id))
      .where(eq(meetingParticipants.meetingId, meetingId));

    for (const { agent } of participantRows) {
      this.emit(meetingId, { type: "turn_started", agentId: agent.id, agentName: agent.name });
      const transcript = await this.buildTranscript(meetingId);
      const adapter = await providers.getAdapter(agent.providerConfigId);

      const basePrompt = await buildSystemPrompt(db, agent);
      const system = `${basePrompt}\n\nYou are in a live meeting with the user and teammates. Respond as yourself (${agent.name}, ${agent.role}) in your own voice — concise, no stage directions, no re-introducing yourself. If you have nothing to add, say so briefly.`;

      const response = await adapter.chat({
        model: agent.model,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
        maxTokens: 1024,
      });

      const content: ContentBlock[] = response.content.filter((b) => b.type === "text");
      const id = newId();
      const createdAt = new Date();
      await db.insert(meetingMessages).values({
        id,
        meetingId,
        senderAgentId: agent.id,
        content: JSON.stringify(content),
        createdAt,
      });
      await db.update(meetings).set({ updatedAt: createdAt }).where(eq(meetings.id, meetingId));

      const pricing = adapter.pricing(agent.model);
      const cost = pricing
        ? ((response.usage.inputTokens - (response.usage.cachedInputTokens ?? 0)) / 1_000_000) * pricing.inputPerMillion +
          ((response.usage.cachedInputTokens ?? 0) / 1_000_000) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) +
          (response.usage.outputTokens / 1_000_000) * pricing.outputPerMillion
        : 0;
      await db.insert(usageRecords).values({
        id: newId(),
        sessionId: null,
        userId: await this.deps.userId(),
        provider: adapter.id,
        model: agent.model,
        purpose: "agent_turn",
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
        cachedTokensIn: response.usage.cachedInputTokens ?? 0,
        cost,
        at: createdAt,
      });

      this.emit(meetingId, { type: "message", message: { id, meetingId, senderAgentId: agent.id, content, createdAt } });
    }
  }
}
