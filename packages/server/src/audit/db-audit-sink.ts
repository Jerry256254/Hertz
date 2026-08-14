import fs from "node:fs/promises";
import type { AuditEvent, AuditSink } from "@kuclab-hertz/sandbox";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import type { HertzPaths } from "../paths.js";

/** Writes every audit event to the DB (queryable) and mirrors it to an append-only JSONL file (cheap tamper-evidence independent of DB corruption). */
export function createDbAuditSink(db: Database, paths: HertzPaths): AuditSink {
  return {
    async record(event: AuditEvent) {
      const at = new Date();
      await db.insert(auditLog).values({
        id: newId(),
        actorId: event.actorId,
        actorType: event.actorType,
        sessionId: event.sessionId,
        projectId: event.projectId,
        action: event.action,
        target: event.target,
        targetType: event.targetType,
        result: event.result,
        detail: event.detail ? JSON.stringify(event.detail) : null,
        at,
      });
      await fs.appendFile(paths.auditLogPath, `${JSON.stringify({ ...event, at: at.toISOString() })}\n`, "utf8");
    },
  };
}
