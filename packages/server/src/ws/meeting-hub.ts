import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { requireAuth } from "../auth/plugin.js";

/** Live-tail stream for a meeting round, mirroring ws/session-hub.ts. */
export function registerMeetingWebsocket(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/ws/meetings/:id",
    { websocket: true, preHandler: requireAuth },
    (socket, request) => {
      const { id } = request.params as { id: string };

      const unsubscribe = ctx.meetingOrchestrator.subscribe(id, (event) => {
        socket.send(JSON.stringify(event));
      });

      socket.on("close", () => {
        unsubscribe();
      });
    },
  );
}
