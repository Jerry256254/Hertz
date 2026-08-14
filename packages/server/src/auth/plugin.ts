import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { verifySessionToken, type AuthenticatedUser } from "./session-tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const COOKIE_NAME = "hertz_session";

function extractToken(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return (request.cookies as Record<string, string | undefined> | undefined)?.[COOKIE_NAME];
}

export function registerAuthPlugin(app: FastifyInstance, db: Database): void {
  app.decorateRequest("user", undefined);

  app.addHook("preHandler", async (request) => {
    const token = extractToken(request);
    if (!token) return;
    request.user = await verifySessionToken(db, token);
  });
}

export function requireAuth(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!request.user) {
    reply.code(401).send({ error: "Not authenticated" });
    return;
  }
  done();
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!request.user) {
    reply.code(401).send({ error: "Not authenticated" });
    return;
  }
  if (request.user.role !== "admin") {
    reply.code(403).send({ error: "Admin role required" });
    return;
  }
  done();
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
