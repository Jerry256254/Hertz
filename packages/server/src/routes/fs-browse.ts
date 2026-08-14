import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth/plugin.js";

const querySchema = z.object({ path: z.string().optional() });

/**
 * Browses the server's filesystem so a project root can be picked graphically
 * instead of typed as plain text. Unlike the project file routes, there is no
 * PathGuard containment here by design — there is no root yet, this endpoint is
 * how one gets chosen — so it is admin-only and lists directory names only,
 * never file contents.
 */
export function registerFsBrowseRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAdmin);

    instance.get("/api/fs/browse", async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const home = os.homedir();
      const target = parsed.data.path ? path.resolve(parsed.data.path) : home;

      let dirents: import("node:fs").Dirent[];
      try {
        dirents = await fs.readdir(target, { withFileTypes: true });
      } catch (err) {
        return reply.code(400).send({ error: `Cannot read directory: ${(err as Error).message}` });
      }

      const entries = dirents
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = path.dirname(target);
      return {
        path: target,
        parent: parent !== target ? parent : null,
        home,
        entries,
      };
    });
  });
}
