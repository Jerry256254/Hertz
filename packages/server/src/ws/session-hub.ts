import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { requireAuth } from "../auth/plugin.js";
import { hasProjectAccess } from "../auth/project-access.js";
import { sessions } from "../db/schema.js";
import { stripEmoji } from "../text/strip-emoji.js";
import type { AgentLoopEvent } from "@kuclab-hertz/core";

/**
 * Scrub emoji from the agent's outbound chat text before it reaches the web
 * client. The persona hard-bans emoji and the sanitizer is the safety net —
 * applied here on the live stream; the message-history REST endpoint applies
 * the same scrub on read (see routes/sessions.ts).
 *
 * Only assistant-produced text is touched (text deltas, ask_user questions,
 * saved assistant messages). User messages, tool results, notices and errors
 * pass through unchanged.
 */
function sanitizeEventForWeb(event: AgentLoopEvent): AgentLoopEvent {
  if (event.type === "text_delta" && event.text) {
    const clean = stripEmoji(event.text);
    return clean === event.text ? event : { ...event, text: clean };
  }
  if (event.type === "awaiting_input" && event.question) {
    const clean = stripEmoji(event.question);
    return clean === event.question ? event : { ...event, question: clean };
  }
  if (event.type === "message_saved" && event.message.role === "assistant") {
    const content = event.message.content.map((block) =>
      block.type === "text" && typeof block.text === "string"
        ? { ...block, text: stripEmoji(block.text) }
        : block,
    );
    return { ...event, message: { ...event.message, content } };
  }
  return event;
}

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
          socket.send(JSON.stringify(sanitizeEventForWeb(event)));
        });

        socket.on("close", () => {
          unsubscribe();
        });
      })();
    },
  );
}
