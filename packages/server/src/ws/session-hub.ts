import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { requireAuth } from "../auth/plugin.js";
import { hasProjectAccess } from "../auth/project-access.js";
import { sessions } from "../db/schema.js";

/**
 * Live-tail stream for a running session. Purely a subscriber to AgentLoopManager's
 * in-process emitter — closing this socket never stops the underlying loop, and a
 * client that reconnects later just calls GET /api/sessions/:id first to catch up
 * on history, then resubscribes here for what happens next.
 */
export function registerSessionWebsocket(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/ws/sessions/:id",
    { websocket: true, preHandler: requireAuth },
    (socket, request) => {
      const { id } = request.params as { id: string };

      void (async () => {
        // Authorization: only project members may tail a session's live stream.
        const rows = await ctx.db
          .select({ projectId: sessions.projectId })
          .from(sessions)
          .where(eq(sessions.id, id))
          .limit(1);
        if (!rows[0] || !(await hasProjectAccess(ctx.db, request.user!, rows[0].projectId))) {
          socket.close(4403, "No access to this session");
          return;
        }

        const unsubscribe = ctx.agentLoop.subscribe(id, (event) => {
          socket.send(JSON.stringify(event));
        });

        socket.on("close", () => {
          unsubscribe();
        });
      })();
    },
  );
}
