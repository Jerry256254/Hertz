import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/plugin.js";

export function resolveUpdateLogPath(): string {
  return path.join(process.env.HERTZ_DATA_DIR ?? path.join(process.env.HOME ?? "", ".kuclab-hertz"), "update.log");
}

/**
 * In-place self-update: pulls origin/main, rebuilds, restarts the systemd
 * service (passwordless via the sudoers rule installed by install.sh). Runs
 * detached — the API returns immediately and clients poll the status endpoint.
 * Never touches ~/.kuclab-hertz data.
 */
export function registerUpdateRoutes(app: FastifyInstance, _ctx?: unknown): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/update/status", async (request, reply) => {
      if (request.user?.role !== "admin") return reply.code(403).send({ error: "Admin only" });
      let log = "";
      try {
        log = await fs.readFile(resolveUpdateLogPath(), "utf8");
      } catch {
        /* no update run yet */
      }
      const lines = log.split("\n").filter(Boolean);
      return { running: lines[lines.length - 1]?.includes("update started") === true, log: lines.slice(-60).join("\n") };
    });

    /** Current vs latest available version — powers the Update dialog. */
    instance.get("/api/update/version", async (request, reply) => {
      if (request.user?.role !== "admin") return reply.code(403).send({ error: "Admin only" });

      const { execFile } = await import("node:child_process");
      const sha = await new Promise<string>((resolve) => {
        execFile("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() }, (err, stdout) =>
          resolve(err ? "" : stdout.trim()),
        );
      });

      let version = "";
      try {
        const pkgUrl = new URL("../../../cli/package.json", import.meta.url);
        version = (JSON.parse(await fs.readFile(pkgUrl, "utf8")) as { version: string }).version;
      } catch {
        /* ignore */
      }

      let latest: { tag: string; url: string } | null = null;
      try {
        const res = await fetch("https://api.github.com/repos/Jerry256254/Hertz/releases/latest", {
          headers: { "user-agent": "kuclab-hertz" },
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { tag_name?: string; html_url?: string };
          if (body.tag_name) latest = { tag: body.tag_name, url: body.html_url ?? "" };
        }
      } catch {
        latest = null; // offline / rate-limited — button still works
      }

      return { current: { version, sha }, latest };
    });

    instance.post("/api/update", async (request, reply) => {
      if (request.user?.role !== "admin") return reply.code(403).send({ error: "Admin only" });

      // The server's cwd is the repository checkout when run via the CLI/systemd.
      const scriptPath = path.resolve(process.cwd(), "scripts", "update.sh");
      try {
        await fs.access(scriptPath);
      } catch {
        return reply.code(400).send({
          error: `Update script not found at ${scriptPath} — self-update works only for installs managed by install.sh.`,
        });
      }

      await fs.writeFile(resolveUpdateLogPath(), `[hertz-update] ${new Date().toISOString()} update started\n`);
      const out = await fs.open(resolveUpdateLogPath(), "a");
      const child = spawn("bash", [scriptPath], {
        detached: true,
        stdio: ["ignore", out.fd, out.fd],
        env: process.env,
      });
      child.unref();
      setTimeout(() => void out.close(), 2_000);

      return reply.code(202).send({ ok: true });
    });
  });
}
