import { eq } from "drizzle-orm";
import path from "node:path";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { messageAttachments, sessions } from "../db/schema.js";

/** Telegram's sendDocument cap — files above this are refused with a clear error. */
export const MAX_SEND_FILE_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

/** Best-effort MIME type from the file extension; falls back to octet-stream. */
export function mimeTypeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, "");
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** "prezentace.pptx" — never a path, never empty. */
export function sanitizeFilename(p: string): string {
  const base = path.basename(p).trim();
  return base.length > 0 ? base : "soubor";
}

/** Czech byte formatting: "12 B", "340 kB", "1,2 MB". */
export function formatBytesCs(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0).replace(".", ",")} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export interface RecordFileAttachmentInput {
  sessionId: string;
  messageId: string | null;
  filename: string;
  size: number;
  mimeType: string;
  /** Guard-resolved absolute path (inside the agent's workspace roots). */
  absolutePath: string;
  caption?: string;
}

export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;

/** Persists a send_file delivery; returns the row (id drives the download URL). */
export async function recordFileAttachment(db: Database, input: RecordFileAttachmentInput): Promise<MessageAttachmentRow> {
  const id = newId();
  const createdAt = new Date();
  await db.insert(messageAttachments).values({
    id,
    sessionId: input.sessionId,
    messageId: input.messageId,
    filename: input.filename,
    size: input.size,
    mimeType: input.mimeType,
    absolutePath: input.absolutePath,
    caption: input.caption ?? null,
    createdAt,
  });
  const rows = await db.select().from(messageAttachments).where(eq(messageAttachments.id, id)).limit(1);
  return rows[0]!;
}

export type AttachmentDownloadCheck =
  | { status: "ok"; attachment: MessageAttachmentRow }
  | { status: "not_found" }
  | { status: "wrong_project" };

/**
 * Resolves an attachment id for download. Purely id-based — the request never
 * carries a path, so there is no traversal surface. A wrong projectId is
 * reported as not_found (never confirm or deny another project's files).
 */
export async function checkAttachmentDownload(
  db: Database,
  attachmentId: string,
  projectId: string,
): Promise<AttachmentDownloadCheck> {
  const rows = await db.select().from(messageAttachments).where(eq(messageAttachments.id, attachmentId)).limit(1);
  const attachment = rows[0];
  if (!attachment) return { status: "not_found" };
  const sessRows = await db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, attachment.sessionId)).limit(1);
  const session = sessRows[0];
  if (!session || session.projectId !== projectId) return { status: "wrong_project" };
  return { status: "ok", attachment };
}

/** All attachments of one session, oldest first — for embedding into messages. */
export async function listSessionAttachments(db: Database, sessionId: string): Promise<MessageAttachmentRow[]> {
  return db.select().from(messageAttachments).where(eq(messageAttachments.sessionId, sessionId)).orderBy(messageAttachments.createdAt);
}
