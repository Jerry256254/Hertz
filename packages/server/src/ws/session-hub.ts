import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { requireAuth } from "../auth/plugin.js";

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

      const unsubscribe = ctx.agentLoop.subscribe(id, (event) => {
        socket.send(JSON.stringify(event));
      });

      socket.on("close", () => {
        unsubscribe();
      });
    },
  );
}
