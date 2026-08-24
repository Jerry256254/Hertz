import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { hasProjectAccess } from "../auth/project-access.js";
import { requireAuth } from "../auth/plugin.js";
import { signScreenToken, verifyScreenToken } from "../secrets/screen-token.js";
import type { AppContext } from "../context.js";
import { agents, sessions as sessionsTable } from "../db/schema.js";
import { enqueueAgentRun } from "../runtime/run-jobs.js";

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // take-over links live max 6h

/**
 * The agent's screen, end to end:
 * - status/start manage the Xvfb+x11vnc+noVNC stack inside the container,
 * - a signed token unlocks the viewer page and the WS proxy for ONE agent,
 * - the proxy pipes the browser's WebSocket straight into the container's
 *   websockify (localhost-published port) — access control stays in Hertz,
 * - noVNC client assets are served from our own node_modules (no CDN).
 */
export function registerScreenRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/agents/:id/screen/status", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await canAccess(ctx, request, id))) return reply.code(403).send({ error: "No access" });
      const status = await ctx.desktop.status(id);
      return { ...status };
    });

    instance.post("/api/agents/:id/screen/start", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await canAccess(ctx, request, id))) return reply.code(403).send({ error: "No access" });
      try {
        const status = await ctx.desktop.start(id);
        return { ok: true, ...status };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    });

    /** Signed token for the standalone viewer page / WS proxy. */
    instance.get("/api/agents/:id/screen/token", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await canAccess(ctx, request, id))) return reply.code(403).send({ error: "No access" });

      let hostPort: number | undefined;
      try {
        const started = await ctx.desktop.start(id);
        hostPort = started.hostPort;
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
      if (!hostPort) return reply.code(500).send({ error: "Desktop is running but its port is not published — recreate the container." });

      const token = signScreenToken(ctx.masterKey, { agentId: id, exp: Date.now() + TOKEN_TTL_MS });
      return { token, expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(), hostPort };
    });

    /** User finished the login on the streamed screen — resume the parked bot. */
    instance.post("/api/agents/:id/takeover/done", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await canAccess(ctx, request, id))) return reply.code(403).send({ error: "No access" });

      const pending = await findPendingTakeoverSession(ctx, id);
      if (pending) {
        const meta = { ...pending.metadata };
        delete meta.pendingQuestion;
        delete meta.pendingQuestionAgentId;
        delete meta.pendingTakeover;
        await ctx.db
          .update(sessionsTable)
          .set({ status: "active", metadata: JSON.stringify(meta), updatedAt: new Date() })
          .where(eq(sessionsTable.id, pending.sessionId));

        await ctx.agentLoop.appendInbound(pending.sessionId, [
          {
            type: "text",
            text: "[The user finished logging in on your screen.] The browser session is now signed in — continue exactly where you stopped.",
          },
        ]);
        try {
          await enqueueAgentRun(ctx, { sessionId: pending.sessionId, prePersisted: true, forceAgentId: id }, { maxAttempts: 2 });
        } catch {
          /* already running — inbound will be picked up mid-run */
        }
      }

      return { ok: true };
    });
  });

  // --- noVNC client assets, served from our own node_modules (no CDN) -------
  // (resolve via the package entry — its exports map hides package.json)
  let novncPkgDir: string | null = null;
  try {
    const entry = createRequire(import.meta.url).resolve("@novnc/novnc"); // …/novnc/core/rfb.js
    novncPkgDir = path.dirname(path.dirname(entry));
  } catch {
    novncPkgDir = null; // dependency missing — /novnc/* will 404, everything else works
  }
  app.get("/novnc/*", async (request, reply) => {
    const rest = (request.params as { "*": string })["*"] ?? "";
    const rel =
      rest === "rfb.js"
        ? path.join("core", "rfb.js")
        : rest.startsWith("vendor/")
          ? rest
          : path.join("core", rest);
    if (!novncPkgDir) return reply.code(404).send("noVNC assets unavailable");
    const filePath = path.join(novncPkgDir, rel);
    if (!filePath.startsWith(novncPkgDir) || !fsSync.existsSync(filePath) || !fsSync.statSync(filePath).isFile()) {
      return reply.code(404).send("not found");
    }
    reply.type(rest.endsWith(".js") ? "text/javascript" : "application/octet-stream");
    return reply.send(fsSync.createReadStream(filePath));
  });

  // --- public-with-token endpoints (take-over links) ------------------------
  app.get("/screen/:agentId", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const { t } = request.query as { t?: string };
    if (!t || !verifyScreenToken(ctx.masterKey, t, agentId)) {
      return reply.code(403).send("This screen link is invalid or expired.");
    }
    reply.type("text/html").send(viewerHtml(agentId, t));
  });

  // Authenticated-by-token WS proxy into the container's noVNC websocket.
  app.get("/ws/agents/:agentId/screen", { websocket: true }, (conn: WebSocket, request) => {
    const { agentId } = request.params as { agentId: string };
    const { t } = request.query as { t?: string };
    if (!t || !verifyScreenToken(ctx.masterKey, t, agentId)) {
      conn.close(4403, "invalid token");
      return;
    }

    void (async () => {
      const hostPort = await ctx.desktop.resolveHostPort(agentId);
      if (!hostPort) {
        conn.close(1011, "desktop not running");
        return;
      }
      let upstream: WebSocket | undefined;
      try {
        upstream = new WebSocket(`ws://127.0.0.1:${hostPort}/websockify`, { maxPayload: 0 });
      } catch {
        conn.close(1011, "cannot reach desktop");
        return;
      }

      upstream.on("open", () => {
        conn.on("message", (data: Buffer, isBinary: boolean) => {
          if (upstream!.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        conn.on("close", () => upstream?.close());
        conn.on("error", () => upstream?.close());
      });
      upstream.on("message", (data: Buffer, isBinary: boolean) => {
        if (conn.readyState === 1) conn.send(data, { binary: isBinary });
      });
      upstream.on("close", () => conn.close());
      upstream.on("error", () => conn.close());
    })();
  });
}

// --- helpers -----------------------------------------------------------------

async function canAccess(ctx: AppContext, request: FastifyRequest, agentId: string): Promise<boolean> {
  const user = request.user!;
  if (user.role === "admin") return true;
  const rows = await ctx.db.select({ projectId: agents.projectId }).from(agents).where(eq(agents.id, agentId)).limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) return false;
  return hasProjectAccess(ctx.db, user, projectId);
}

export async function findPendingTakeoverSession(
  ctx: AppContext,
  agentId: string,
): Promise<{ sessionId: string; metadata: Record<string, unknown> } | undefined> {
  const rows = await ctx.db
    .select({ id: sessionsTable.id, metadata: sessionsTable.metadata })
    .from(sessionsTable)
    .where(eq(sessionsTable.agentId, agentId));
  for (const row of [...rows].reverse()) {
    if (!row.metadata) continue;
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      if (meta.pendingTakeover) return { sessionId: row.id, metadata: meta };
    } catch {
      /* skip malformed metadata */
    }
  }
  return undefined;
}

export function takeoverMessageText(reason: string, lanUrl: string | null): string {
  return `I need you to take over my screen and complete this step for me: ${reason}\nOpen my screen here${lanUrl ? `:\n${lanUrl}` : " from the WebUI (employee page → Screen)."}`;
}

function viewerHtml(agentId: string, token: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Hertz — agent screen</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;background:#0b0d10;color:#e5e7eb;font-family:system-ui,sans-serif;display:flex;flex-direction:column;height:100vh}
  header{display:flex;gap:12px;align-items:center;padding:8px 14px;border-bottom:1px solid #22262c}
  .dot{width:8px;height:8px;border-radius:50%;background:#f59e0b}
  #status{font-size:13px;color:#9ca3af}
  main{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}
  #screen{width:100%;height:calc(100vh - 45px)}
  button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer}
</style></head>
<body>
<header><span class="dot" id="dot"></span><span id="status">Connecting…</span>
<span style="flex:1"></span><button id="done">I'm done — hand back to the agent</button></header>
<main><div id="screen"></div></main>
<script type="module">
  import RFB from "/novnc/rfb.js";
  const AGENT_ID = ${JSON.stringify(agentId)};
  const TOKEN = ${JSON.stringify(token)};
  document.getElementById("done").addEventListener("click", async () => {
    try {
      await fetch("/api/agents/" + AGENT_ID + "/takeover/done", { method: "POST", credentials: "include" });
    } catch (e) { /* link-only viewers just close */ }
    document.getElementById("status").textContent = "Handed back to the agent — you can close this tab.";
    try { window.rfb && window.rfb.disconnect(); } catch (e) {}
  });
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = proto + "//" + location.host + "/ws/agents/" + AGENT_ID + "/screen?t=" + encodeURIComponent(TOKEN);
  const rfb = new RFB(document.getElementById("screen"), url, { scaleViewport: true, resizeSession: false });
  window.rfb = rfb;
  rfb.addEventListener("connect", () => {
    document.getElementById("dot").style.background = "#22c55e";
    document.getElementById("status").textContent = "Live — you are controlling the agent desktop";
  });
  rfb.addEventListener("disconnect", () => {
    document.getElementById("dot").style.background = "#ef4444";
    document.getElementById("status").textContent = "Disconnected — refresh to reconnect";
  });
</script>
</body></html>`;
}
