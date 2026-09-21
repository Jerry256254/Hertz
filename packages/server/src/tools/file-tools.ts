import fs from "node:fs/promises";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { messages } from "../db/schema.js";
import type { AgentToolDef } from "./tool-def.js";
import type { ToolContext, ToolResult } from "@kuclab-hertz/tools";
import {
  MAX_SEND_FILE_BYTES,
  formatBytesCs,
  mimeTypeForFilename,
  recordFileAttachment,
  sanitizeFilename,
} from "../files/attachments.js";

const sendFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Cesta k souboru ve tvém pracovním prostoru (relativně k jeho kořenu), např. 'prezentace.pptx' nebo 'weby/landing/index.html'"),
  caption: z
    .string()
    .max(1024)
    .optional()
    .describe("Krátký popisek k souboru (česky), např. 'Prezentace k narozeninám'"),
});

/**
 * send_file — the agent's way of DELIVERING a file to the user. Use it
 * whenever the user should receive a file you created (presentation, HTML
 * page, report, image…): the file appears in the chat as a downloadable
 * attachment and is sent as a document on Telegram. Never just describe
 * where the file lives — send it.
 *
 * Security: the path goes through the sandbox PathGuard, so only files
 * inside the agent's workspace/project roots can be sent. Absolute paths
 * outside the workspace and ".." escapes are rejected by the guard.
 */
export function createFileTools(db: Database): AgentToolDef[] {
  const sendFile: AgentToolDef = {
    name: "send_file",
    description:
      "Odešli uživateli soubor, který jsi vytvořil (prezentace, HTML stránka, report, obrázek…). Soubor se uživateli zobrazí v chatu jako příloha ke stažení a na Telegramu dorazí jako dokument. Cesta je relativní ke kořenu tvého pracovního prostoru. Použij vždy, když má uživatel soubor dostat — nikdy jen nepopisuj, kde soubor leží.",
    inputSchema: sendFileSchema,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = sendFileSchema.safeParse(input);
      if (!parsed.success) {
        return { summary: `Soubor se nepodařilo odeslat: neplatný vstup (${parsed.error.message}).`, isError: true };
      }
      const sessionId = ctx.actor.sessionId;
      if (!sessionId) {
        return { summary: "Soubor se nepodařilo odeslat: chybí session.", isError: true };
      }

      const { path: relPath, caption } = parsed.data;

      // PathGuard = the traversal guard: resolves only inside the agent's
      // workspace roots, rejects absolute escapes and ".." breakouts.
      let abs: string;
      try {
        abs = ctx.pathGuard.resolve(
          {
            actorId: ctx.actor.actorId,
            actorType: "agent",
            sessionId,
            projectId: ctx.actor.projectId,
            userId: ctx.actor.userId,
          },
          ctx.rootId,
          relPath,
        );
      } catch (err) {
        return {
          summary: `Soubor "${relPath}" nelze odeslat: ${(err as Error).message}. Posílat lze jen soubory z tvého workspace.`,
          isError: true,
        };
      }

      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) {
        return { summary: `Soubor "${relPath}" nelze odeslat: cesta neexistuje.`, isError: true };
      }
      if (!stat.isFile()) {
        return { summary: `Soubor "${relPath}" nelze odeslat: není to soubor.`, isError: true };
      }
      if (stat.size > MAX_SEND_FILE_BYTES) {
        return {
          summary: `Soubor "${relPath}" nelze odeslat: má ${formatBytesCs(stat.size)}, maximum je ${formatBytesCs(MAX_SEND_FILE_BYTES)}.`,
          isError: true,
        };
      }

      const filename = sanitizeFilename(abs);
      const mimeType = mimeTypeForFilename(filename);

      // Bind the file to the assistant message whose tool call sent it, so the
      // WebUI renders the attachment on the right bubble.
      const recent = await db
        .select({ id: messages.id, role: messages.role })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(desc(messages.createdAt))
        .limit(10);
      const messageId = recent.find((r) => r.role === "assistant")?.id ?? null;

      const attachment = await recordFileAttachment(db, {
        sessionId,
        messageId,
        filename,
        size: stat.size,
        mimeType,
        absolutePath: abs,
        caption,
      });

      return {
        summary: `Soubor "${filename}" (${formatBytesCs(stat.size)}) byl odeslán uživateli.`,
        fileAttachment: {
          id: attachment.id,
          absolutePath: abs,
          filename,
          size: stat.size,
          mimeType,
          ...(caption ? { caption } : {}),
        },
      };
    },
  };

  return [sendFile];
}
