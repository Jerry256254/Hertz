import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requireAuth } from "../auth/plugin.js";

const resetSchema = z.object({ confirm: z.literal("RESET") });

/**
 * Factory reset — wipes Hertz back to a pristine first-install state:
 * - stops and removes every agent container (their volumes live in the data dir)
 * - writes reset.flag; the server exits and (under systemd) restarts
 * - on the next boot createAppContext sees the flag and deletes the entire
 *   data directory contents (DB, chats, memory, keys, projects) — like a
 *   fresh download.
 */
export function registerResetRoute(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.post("/api/admin/reset", async (request, reply) => {
      if (request.user?.role !== "admin") return reply.code(403).send({ error: "Admin only" });
      const parsed = resetSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Type "RESET" to confirm.' });

      // Best effort: remove this install's agent containers so nothing keeps
      // writing after the wipe.
      const cleanup = spawn(
        "bash",
        ["-lc", "docker ps -aq --filter label=kuclab-hertz.managed=true | xargs -r docker rm -f"],
        { stdio: "ignore" },
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        cleanup.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
        cleanup.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      await fs.writeFile(path.join(ctx.paths.dataDir, "reset.flag"), `web-reset by ${request.user!.email}`);

      // Give the response a moment to flush, then exit; systemd restarts us
      // into a clean first boot.
      setTimeout(() => process.exit(42), 400);
      return { ok: true, message: "Resetting… the server restarts into a fresh install in a few seconds." };
    });
  });
}
