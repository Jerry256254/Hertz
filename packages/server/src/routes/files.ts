import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { projectRoots } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";

const listQuerySchema = z.object({ path: z.string().optional().default(".") });

const MAX_PREVIEW_BYTES = 200_000;

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    async function buildGuard(projectId: string) {
      const rows = await ctx.db.select().from(projectRoots).where(eq(projectRoots.projectId, projectId));
      if (rows.length === 0) return undefined;
      const roots = Object.fromEntries(rows.map((r) => [r.rootId, r.absolutePath]));
      return { guard: ctx.sandboxRegistry.buildPathGuard(roots), rootId: rows[0]!.rootId };
    }

    instance.get("/api/projects/:projectId/files", async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const built = await buildGuard(projectId);
      if (!built) return reply.code(404).send({ error: "Project has no roots configured" });

      let abs: string;
      try {
        abs = built.guard.resolve(
          { actorId: request.user!.id, actorType: "user", projectId },
          built.rootId,
          parsed.data.path,
        );
      } catch (err) {
        return reply.code(403).send({ error: (err as Error).message });
      }

      const entries = await fs.readdir(abs, { withFileTypes: true });
      return {
        entries: entries
          .filter((e) => e.name !== ".git" && e.name !== "node_modules")
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : "file",
          }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1)),
      };
    });

    instance.get("/api/projects/:projectId/file-content", async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const built = await buildGuard(projectId);
      if (!built) return reply.code(404).send({ error: "Project has no roots configured" });

      let abs: string;
      try {
        abs = built.guard.resolve(
          { actorId: request.user!.id, actorType: "user", projectId },
          built.rootId,
          parsed.data.path,
        );
      } catch (err) {
        return reply.code(403).send({ error: (err as Error).message });
      }

      const stat = await fs.stat(abs);
      if (stat.isDirectory()) return reply.code(400).send({ error: "Path is a directory" });

      const content = await fs.readFile(abs, { encoding: "utf8", flag: "r" });
      const truncated = content.length > MAX_PREVIEW_BYTES;
      return {
        path: parsed.data.path,
        size: stat.size,
        truncated,
        content: truncated ? content.slice(0, MAX_PREVIEW_BYTES) : content,
      };
    });
  });
}
