import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agents, channelConfigs } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth, requireAdmin } from "../auth/plugin.js";
import { encryptSecret, maskKey } from "../secrets/key-encryption.js";

const createSchema = z.object({
  kind: z.enum(["telegram", "discord"]),
  label: z.string().min(1).max(80),
  token: z.string().min(10),
  defaultAgentId: z.string().min(1),
  /** JSON array of external chat ids; empty array or omitted = allow all. */
  allowedChats: z.array(z.string()).optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  token: z.string().min(10).optional(),
  defaultAgentId: z.string().min(1).nullable().optional(),
  allowedChats: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

function serializeAllowedChats(list?: string[]): string | null {
  return list ? JSON.stringify(list) : null;
}

export function registerChannelRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAdmin);

    instance.get("/api/channels", async () => {
      const rows = await ctx.db
        .select({ config: channelConfigs, agentName: agents.name })
        .from(channelConfigs)
        .leftJoin(agents, eq(channelConfigs.defaultAgentId, agents.id))
        .orderBy(desc(channelConfigs.createdAt));
      // Token material never leaves the server — only a masked hint.
      const tokenRaw = rows.map((r) => r.config.encryptedToken);
      void tokenRaw;
      return {
        channels: rows.map(({ config, agentName }) => ({
          id: config.id,
          kind: config.kind,
          label: config.label,
          tokenHint: maskKeyHint(config.id),
          defaultAgentId: config.defaultAgentId,
          agentName: agentName ?? null,
          allowedChats: config.allowedChatsJson ? (JSON.parse(config.allowedChatsJson) as string[]) : [],
          enabled: config.enabled,
          live: ctx.channelManager.isLive(config.id),
        })),
      };
    });

    instance.post("/api/channels", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const id = newId();
      await ctx.db.insert(channelConfigs).values({
        id,
        kind: parsed.data.kind,
        label: parsed.data.label,
        encryptedToken: encryptSecret(ctx.masterKey, parsed.data.token),
        defaultAgentId: parsed.data.defaultAgentId,
        allowedChatsJson: serializeAllowedChats(parsed.data.allowedChats),
        enabled: true,
        createdAt: new Date(),
      });
      await ctx.channelManager.restart(id);
      return reply.code(201).send({ id });
    });

    instance.patch("/api/channels/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const patch: Partial<typeof channelConfigs.$inferInsert> = {};
      if (parsed.data.label !== undefined) patch.label = parsed.data.label;
      if (parsed.data.token !== undefined) patch.encryptedToken = encryptSecret(ctx.masterKey, parsed.data.token);
      if (parsed.data.defaultAgentId !== undefined) patch.defaultAgentId = parsed.data.defaultAgentId;
      if (parsed.data.allowedChats !== undefined) patch.allowedChatsJson = serializeAllowedChats(parsed.data.allowedChats);
      if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;

      await ctx.db.update(channelConfigs).set(patch).where(eq(channelConfigs.id, id));
      await ctx.channelManager.restart(id);
      return { ok: true };
    });

    instance.delete("/api/channels/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      ctx.channelManager.stopOne(id);
      await ctx.db.delete(channelConfigs).where(eq(channelConfigs.id, id));
      return reply.code(204).send();
    });
  });
}

/** Deterministic non-sensitive hint so the UI can show WHICH token is stored without exposing it. */
function maskKeyHint(id: string): string {
  return `••••${id.slice(-4)}`;
}
