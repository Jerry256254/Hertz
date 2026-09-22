import { asc, eq } from "drizzle-orm";
import type { ContentBlock } from "@kuclab-hertz/providers";
import type { FileAttachmentInfo, PersistedMessage, PersistencePort, UsageRecordInput } from "@kuclab-hertz/core";
import { contentLooksInternal } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { agentMemoryAtoms, agents, messageAttachments, messages, sessions, usageRecords } from "../db/schema.js";
import { keywordsFor } from "../memory/tokenize.js";

function toPersistedMessage(row: typeof messages.$inferSelect): PersistedMessage {
  const content = JSON.parse(row.content) as ContentBlock[];
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content,
    senderAgentId: row.senderAgentId,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensIn,
    cachedTokensIn: row.cachedTokensIn,
    cost: row.cost,
    purpose: row.purpose,
    createdAt: row.createdAt,
    // Zpětná kompatibilita: starší buildy persistovaly interní systémové
    // zprávy (guard nudge aj.) s rolí "user" a bez příznaku — při čtení je
    // podle textového prefixu označíme jako skryté, aby je UI nikdy
    // nevyrenderovalo jako bublinu uživatele.
    hidden: row.hidden === 1 || contentLooksInternal(content),
  };
}

export function createPersistenceAdapter(db: Database): PersistencePort {
  return {
    async appendMessage(msg) {
      const id = newId();
      const createdAt = new Date();
      await db.insert(messages).values({
        id,
        sessionId: msg.sessionId,
        role: msg.role,
        content: JSON.stringify(msg.content),
        senderAgentId: msg.senderAgentId ?? null,
        tokensIn: msg.tokensIn,
        tokensOut: msg.tokensOut,
        cachedTokensIn: msg.cachedTokensIn,
        cost: msg.cost,
        purpose: msg.purpose,
        hidden: msg.hidden ? 1 : 0,
        createdAt,
      });
      await db.update(sessions).set({ updatedAt: createdAt }).where(eq(sessions.id, msg.sessionId));
      return { ...msg, id, createdAt };
    },

    async listMessages(sessionId) {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.createdAt));
      // Attachments the agent sent with send_file, keyed by message.
      const attRows = await db
        .select()
        .from(messageAttachments)
        .where(eq(messageAttachments.sessionId, sessionId))
        .orderBy(asc(messageAttachments.createdAt));
      const byMessage = new Map<string, FileAttachmentInfo[]>();
      for (const a of attRows) {
        if (!a.messageId) continue;
        const info: FileAttachmentInfo = {
          id: a.id,
          filename: a.filename,
          size: a.size,
          mimeType: a.mimeType,
          caption: a.caption,
          createdAt: a.createdAt,
        };
        const list = byMessage.get(a.messageId);
        if (list) list.push(info);
        else byMessage.set(a.messageId, [info]);
      }
      return rows.map((row) => {
        const msg = toPersistedMessage(row);
        const atts = byMessage.get(row.id);
        if (atts) msg.attachments = atts;
        return msg;
      });
    },

    async updateSessionStatus(sessionId, status) {
      await db.update(sessions).set({ status, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
    },

    async getSessionMetadata(sessionId) {
      const rows = await db
        .select({ metadata: sessions.metadata })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const raw = rows[0]?.metadata;
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    },

    async setSessionMetadata(sessionId, metadata) {
      await db
        .update(sessions)
        .set({ metadata: JSON.stringify(metadata), updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
    },

    async recordUsage(rec: UsageRecordInput) {
      await db.insert(usageRecords).values({
        id: newId(),
        sessionId: rec.sessionId,
        userId: rec.userId,
        provider: rec.provider,
        model: rec.model,
        purpose: rec.purpose,
        tokensIn: rec.tokensIn,
        tokensOut: rec.tokensOut,
        cachedTokensIn: rec.cachedTokensIn,
        cost: rec.cost,
        at: new Date(),
      });
    },

    async updateAgentLastStatus(agentId, status) {
      await db.update(agents).set({ lastStatus: status }).where(eq(agents.id, agentId));
    },

    async appendMemoryNote(agentId, note, meta) {
      // Layered memory: auto-episodes land in L1 as low-importance atoms and
      // get distilled, clustered, and aged out by the pipeline — the legacy
      // agent_memory table only keeps pre-layered rows for rollback.
      await db.insert(agentMemoryAtoms).values({
        id: newId(),
        agentId,
        text: note.slice(0, 500),
        importance: meta?.importance ?? (meta?.kind === "preference" ? 4 : meta?.kind === "episode" ? 1 : 2),
        keywords: meta?.keywords ?? keywordsFor(note),
        createdAt: new Date(),
      });
    },
  };
}
