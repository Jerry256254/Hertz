import fs from "node:fs";
import fsPromises from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requireAuth } from "../auth/plugin.js";
import { hasProjectAccess } from "../auth/project-access.js";
import { checkAttachmentDownload } from "../files/attachments.js";

const paramsSchema = z.object({
  projectId: z.string().min(1),
  attachmentId: z.string().min(1),
});

const querySchema = z.object({
  /** inline=1 → Content-Disposition: inline (image/HTML previews); default is attachment (download). */
  inline: z.enum(["0", "1"]).optional().default("0"),
});

/**
 * File downloads for agent-sent attachments. Lookup is strictly by
 * attachment id — the request never carries a filesystem path, so there is
 * no path traversal surface. The attachment's session must belong to the
 * requested project and the caller needs project access.
 */
export function registerAttachmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/projects/:projectId/attachments/:attachmentId", async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const query = querySchema.safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ error: "Neplatný požadavek" });
      const { projectId, attachmentId } = params.data;

      if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) {
        return reply.code(403).send({ error: "No access to this project" });
      }

      const check = await checkAttachmentDownload(ctx.db, attachmentId, projectId);
      if (check.status !== "ok") return reply.code(404).send({ error: "Příloha neexistuje" });
      const attachment = check.attachment;

      const stat = await fsPromises.stat(attachment.absolutePath).catch(() => null);
      if (!stat || !stat.isFile()) {
        return reply.code(404).send({ error: "Soubor už na serveru neexistuje" });
      }

      const disposition = query.data.inline === "1" ? "inline" : "attachment";
      reply.header("Content-Type", attachment.mimeType);
      reply.header("Content-Length", stat.size);
      // RFC 5987 encoding — Czech filenames survive the round-trip.
      reply.header("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
      // The file came from the agent's own workspace; never sniff it as something else.
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(fs.createReadStream(attachment.absolutePath));
    });
  });
}
