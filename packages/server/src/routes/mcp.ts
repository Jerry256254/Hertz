import type { FastifyInstance } from "fastify";
import { eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agents, mcpServers } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { encryptSecret } from "../secrets/key-encryption.js";

const createSchema = z
  .object({
    name: z.string().min(1),
    /** Omit or null for a server available to every agent; set to scope it to one employee. */
    agentId: z.string().nullable().optional(),
    transport: z.enum(["stdio", "sse"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
  })
  .refine((v) => (v.transport === "stdio" ? !!v.command : !!v.url), {
    message: "stdio needs command, sse needs url",
  });

const updateSchema = z.object({ enabled: z.boolean() });

function toRow(id: string, input: z.infer<typeof createSchema>, masterKey: Buffer) {
  const secretMap = input.transport === "stdio" ? input.env : input.headers;
  return {
    id,
    agentId: input.agentId ?? null,
    name: input.name,
    transport: input.transport,
    command: input.transport === "stdio" ? (input.command ?? null) : null,
    argsJson: input.transport === "stdio" && input.args ? JSON.stringify(input.args) : null,
    encryptedEnv: secretMap && Object.keys(secretMap).length > 0 ? encryptSecret(masterKey, JSON.stringify(secretMap)) : null,
    url: input.transport === "sse" ? (input.url ?? null) : null,
    enabled: true,
    createdAt: new Date(),
  };
}

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/mcp-servers", async (request) => {
      const { agentId } = request.query as { agentId?: string };
      const rows = agentId
        ? await ctx.db.select().from(mcpServers).where(or(isNull(mcpServers.agentId), eq(mcpServers.agentId, agentId)))
        : await ctx.db.select().from(mcpServers);
      return {
        servers: rows.map((r) => ({
          id: r.id,
          agentId: r.agentId,
          name: r.name,
          transport: r.transport,
          command: r.command,
          args: r.argsJson ? (JSON.parse(r.argsJson) as string[]) : [],
          url: r.url,
          hasSecret: !!r.encryptedEnv,
          enabled: r.enabled,
          createdAt: r.createdAt,
        })),
      };
    });

    instance.get("/api/agents/:agentId/mcp-tools", async (request, reply) => {
      const { agentId } = request.params as { agentId: string };
      const rows = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Agent not found" });
      return { servers: await ctx.mcpRegistry.listForDisplay(agentId) };
    });

    instance.post("/api/mcp-servers", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const id = newId();
      await ctx.db.insert(mcpServers).values(toRow(id, parsed.data, ctx.masterKey));
      return reply.code(201).send({ id });
    });

    instance.patch("/api/mcp-servers/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const rows = await ctx.db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "MCP server not found" });

      await ctx.db.update(mcpServers).set({ enabled: parsed.data.enabled }).where(eq(mcpServers.id, id));
      ctx.mcpRegistry.invalidate(id);
      return { ok: true };
    });

    instance.delete("/api/mcp-servers/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "MCP server not found" });

      await ctx.db.delete(mcpServers).where(eq(mcpServers.id, id));
      ctx.mcpRegistry.invalidate(id);
      return reply.code(204).send();
    });
  });
}
