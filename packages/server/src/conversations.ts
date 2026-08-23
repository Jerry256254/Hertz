import { and, desc, eq, inArray } from "drizzle-orm";
import { aliasedTable, or } from "drizzle-orm";
import type { AgentLoopManager } from "@kuclab-hertz/core";
import type { Database } from "./db/client.js";
import { newId } from "./db/client.js";
import { agents, messages, sessions } from "./db/schema.js";
import type { JobQueue } from "./queue/job-queue.js";
import { enqueueAgentRun } from "./runtime/run-jobs.js";

/**
 * A direct agent ↔ agent chat ("conversation") is a session with
 * kind = "conversation": both sides' messages live in one thread that has its
 * own context window (budget, compact, WS live-tail — everything a normal chat
 * has), and message_employee delivers into it. The pair is keyed
 * deterministically: sessions.agentId = lexicographically smaller agent id,
 * peerAgentId = the other, so both directions share exactly one thread.
 */
export interface ConversationDeps {
  db: Database;
  /** Lazy — AgentLoopManager doesn't exist yet when tools are constructed. */
  agentLoop: AgentLoopManager;
  queue: JobQueue;
}

export async function ensureConversationSession(
  deps: ConversationDeps,
  args: { projectId: string; senderId: string; recipientId: string; senderName: string; recipientName: string },
): Promise<typeof sessions.$inferSelect> {
  const { db } = deps;
  const [smallId, largeId] = args.senderId < args.recipientId
    ? [args.senderId, args.recipientId]
    : [args.recipientId, args.senderId];

  const existing = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, args.projectId),
        eq(sessions.kind, "conversation"),
        eq(sessions.agentId, smallId),
        eq(sessions.peerAgentId, largeId),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const now = new Date();
  const id = newId();
  await db
    .insert(sessions)
    .values({
      id,
      agentId: smallId,
      peerAgentId: largeId,
      projectId: args.projectId,
      kind: "conversation",
      title: `${args.recipientName} & ${args.senderName}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, args.projectId),
        eq(sessions.kind, "conversation"),
        eq(sessions.agentId, smallId),
        eq(sessions.peerAgentId, largeId),
      ),
    )
    .limit(1);
  return rows[0]!;
}

/** Persists an inbound agent message into a conversation and notifies live subscribers. */
export async function deliverConversationMessage(
  deps: ConversationDeps,
  args: { sessionId: string; senderAgentId: string; text: string },
): Promise<void> {
  await deps.agentLoop.appendInbound(args.sessionId, [{ type: "text", text: args.text }], args.senderAgentId);
}

/**
 * Starts (or piggybacks on) the recipient agent's reply run for a conversation
 * thread. Every conversation message gets answered once: when the thread is
 * idle a fresh run starts; when it's already running (another message landed
 * mid-reply) the in-flight loop notices the new inbound message between turns
 * and answers it without a second run.
 */
export async function startConversationReplyRun(
  deps: ConversationDeps,
  args: { sessionId: string; actorAgentId: string; projectId: string; userId?: string; incomingText: string },
): Promise<void> {
  const { db, agentLoop } = deps;
  if (agentLoop.isRunning(args.sessionId)) return;

  const actorRows = await db.select().from(agents).where(eq(agents.id, args.actorAgentId)).limit(1);
  const actor = actorRows[0];
  if (!actor || actor.approvalStatus !== "approved" || actor.status === "terminated") return;

  const peerRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, args.sessionId))
    .limit(1);
  const session = peerRows[0];
  if (!session) return;
  const peerId = session.agentId === args.actorAgentId ? session.peerAgentId : session.agentId;
  const peerNameRows = peerId
    ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, peerId)).limit(1)
    : [];
  const conversationPeerName = peerNameRows[0]?.name ?? "a colleague";

  try {
    // The agent_run handler rebuilds prompt/sandbox/roots from the DB and
    // withholds message_employee for conversation sessions itself.
    await enqueueAgentRun({ queue: deps.queue }, {
      sessionId: args.sessionId,
      userId: args.userId,
      prePersisted: true,
      conversationPeerName,
    });
  } catch {
    // Lost the race to another trigger — that run will answer the message.
  }
}

/**
 * Which agent should answer the next human message in a conversation: the one
 * who did not speak last (or the home agent when the thread is empty).
 */
export async function pickConversationActor(db: Database, session: typeof sessions.$inferSelect): Promise<string> {
  const rows = await db
    .select({ senderAgentId: messages.senderAgentId })
    .from(messages)
    .where(eq(messages.sessionId, session.id))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const lastSender = rows[0]?.senderAgentId;
  if (!lastSender) return session.agentId;
  if (lastSender === session.agentId) return session.peerAgentId ?? session.agentId;
  return session.agentId;
}

export interface ConversationListItem {
  id: string;
  title: string;
  status: string;
  agentId: string;
  peerAgentId: string;
  agentName: string;
  peerAgentName: string;
  updatedAt: Date;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastSenderAgentId: string | null;
}

/** Every agent ↔ agent conversation in a project, newest first, with the last message preview for the list UI. */
export async function listConversations(db: Database, projectId: string): Promise<ConversationListItem[]> {
  const peer = aliasedTable(agents, "peer");
  const rows = await db
    .select({
      session: sessions,
      agentName: agents.name,
      peerAgentName: peer.name,
    })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    .innerJoin(peer, eq(sessions.peerAgentId, peer.id))
    .where(and(eq(sessions.projectId, projectId), eq(sessions.kind, "conversation")))
    .orderBy(desc(sessions.updatedAt));
  if (rows.length === 0) return [];

  const lastRows = await db
    .select({ sessionId: messages.sessionId, senderAgentId: messages.senderAgentId, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(inArray(messages.sessionId, rows.map((r) => r.session.id)))
    .orderBy(desc(messages.createdAt));

  const lastBySession = new Map<string, { senderAgentId: string | null; content: string; createdAt: Date }>();
  for (const m of lastRows) {
    if (!lastBySession.has(m.sessionId)) {
      lastBySession.set(m.sessionId, { senderAgentId: m.senderAgentId, content: m.content, createdAt: m.createdAt });
    }
  }

  return rows.map(({ session, agentName, peerAgentName }) => {
    const last = lastBySession.get(session.id);
    let preview: string | null = null;
    if (last) {
      try {
        const blocks = JSON.parse(last.content) as Array<{ type: string; text?: string }>;
        preview =
          blocks
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim() || "(image)";
        if (preview.length > 90) preview = `${preview.slice(0, 90)}…`;
      } catch {
        preview = null;
      }
    }
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      agentId: session.agentId,
      peerAgentId: session.peerAgentId ?? "",
      agentName,
      peerAgentName,
      updatedAt: session.updatedAt,
      lastMessageAt: last?.createdAt ?? null,
      lastMessagePreview: preview,
      lastSenderAgentId: last?.senderAgentId ?? null,
    };
  });
}

/** Raw text of every recent message sent TO this agent in any conversation that they haven't answered yet — replaces the old flat employeeMessages read for the system prompt. */
export async function recentConversationMessagesFor(
  db: Database,
  agentId: string,
  limit: number,
): Promise<Array<{ fromName: string; body: string; createdAt: Date }>> {
  const convs = await db
    .select({ id: sessions.id, agentId: sessions.agentId, peerAgentId: sessions.peerAgentId })
    .from(sessions)
    .where(
      and(
        eq(sessions.kind, "conversation"),
        or(eq(sessions.agentId, agentId), eq(sessions.peerAgentId, agentId)),
      ),
    );
  if (convs.length === 0) return [];

  const bySession = new Map(convs.map((c) => [c.id, c]));
  const rows = await db
    .select({
      sessionId: messages.sessionId,
      senderAgentId: messages.senderAgentId,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(inArray(messages.sessionId, convs.map((c) => c.id)))
    .orderBy(desc(messages.createdAt));

  const answeredAfter = new Map<string, Date>();
  for (const m of rows) {
    const conv = bySession.get(m.sessionId);
    if (!conv) continue;
    if (m.senderAgentId === agentId) {
      answeredAfter.set(m.sessionId, m.createdAt);
    }
  }

  const inbound = rows.filter((m) => {
    const conv = bySession.get(m.sessionId);
    if (!conv || m.senderAgentId === null || m.senderAgentId === agentId) return false;
    const answered = answeredAfter.get(m.sessionId);
    return !answered || m.createdAt.getTime() > answered.getTime();
  });

  const names = await db.select({ id: agents.id, name: agents.name }).from(agents);
  const nameById = new Map(names.map((a) => [a.id, a.name]));

  return inbound
    .slice(0, limit)
    .map((m) => {
      let body = "(image)";
      try {
        const blocks = JSON.parse(m.content) as Array<{ type: string; text?: string }>;
        const text = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join(" ").trim();
        if (text) body = text;
      } catch {
        /* keep placeholder */
      }
      return { fromName: nameById.get(m.senderAgentId!) ?? "A colleague", body, createdAt: m.createdAt };
    })
    .reverse();
}
