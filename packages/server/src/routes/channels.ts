import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { newId } from "../db/client.js";
import { agents, channelBindings, channelConfigs, projects } from "../db/schema.js";
import { requireAuth } from "../auth/plugin.js";
import { decryptSecret, encryptSecret, maskKey } from "../secrets/key-encryption.js";
import { TelegramDriver } from "../channels/telegram.js";
import { DiscordDriver } from "../channels/discord.js";

const createSchema = z.object({
  kind: z.enum(["telegram", "discord"]),
  label: z.string().min(1).max(80),
  token: z.string().min(10),
  defaultAgentId: z.string().optional(),
  /** External chat/channel ids allowed to use the bot; empty = anyone who finds it. */
  allowedChats: z.array(z.string().min(1)).max(200).optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  token: z.string().min(10).optional(),
  defaultAgentId: z.string().nullable().optional(),
  allowedChats: z.array(z.string().min(1)).max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});

function requireAdmin(request: { user?: { role: string } }): boolean {
  return request.user?.role === "admin";
}

async function verifyToken(kind: "telegram" | "discord", token: string): Promise<string> {
  const driver = kind === "telegram" ? new TelegramDriver(token) : new DiscordDriver(token);
  return driver.verify();
}

/** Chat channels (Telegram/Discord bots) — admin only, tokens never leave the server. */
export function registerChannelRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/channels", async (request, reply) => {
      if (!requireAdmin(request)) return reply.code(403).send({ error: "Admin only" });
      const rows = await ctx.db.select().from(channelConfigs).orderBy(desc(channelConfigs.createdAt));
      const live = new Map(ctx.channels.status().map((s) => [s.configId, s.botLabel]));
      return {
        channels: await Promise.all(
          rows.map(async (c) => {
            let tokenHint = "••••";
            try {
              tokenHint = maskKey(decryptSecret(ctx.masterKey, c.encryptedToken));
            } catch {
              /* corrupted token — UI offers re-entry */
            }
            let allowedChats: string[] = [];
            try {
              const parsed = c.allowedChatsJson ? (JSON.parse(c.allowedChatsJson) as unknown) : [];
              if (Array.isArray(parsed)) allowedChats = parsed.filter((x): x is string => typeof x === "string");
            } catch {
              allowedChats = [];
            }
            return {
              id: c.id,
              kind: c.kind,
              label: c.label,
              tokenHint,
              defaultAgentId: c.defaultAgentId,
              allowedChats,
              enabled: c.enabled,
              running: live.has(c.id),
              botLabel: live.get(c.id) ?? null,
              createdAt: c.createdAt,
            };
          }),
        ),
      };
    });

    /** Agents eligible as a channel's default. */
    instance.get("/api/channels/agents", async (request, reply) => {
      if (!requireAdmin(request)) return reply.code(403).send({ error: "Admin only" });
      const rows = await ctx.db
        .select({ id: agents.id, name: agents.name, projectId: agents.projectId, projectName: projects.name })
        .from(agents)
        .innerJoin(projects, eq(agents.projectId, projects.id))
        .orderBy(desc(agents.createdAt))
        .limit(200);
      return { agents: rows };
    });

    instance.get("/api/channels/bindings", async (request, reply) => {
      if (!requireAdmin(request)) return reply.code(403).send({ error: "Admin only" });
      return { bindings: await ctx.channels.recentBindings(50) };
    });

    instance.post("/api/channels", async (request, reply) => {
      if (!requireAdmin(request)) return reply.code(403).send({ error: "Admin only" });
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      let botLabel: string;
      try {
        botLabel = await verifyToken(parsed.data.kind, parsed.data.token);
      } catch (err) {
        return reply.code(400).send({ error: `Token rejected by ${parsed.data.kind}: ${(err as Error).message}` });
      }

      if (parsed.data.defaultAgentId) {
        const agentRows = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, parsed.data.defaultAgentId)).limit(1);
        if (!agentRows[0]) return reply.code(400).send({ error: "Default agent not found" });
      }

      const id = newId();
      await ctx.db.insert(channelConfigs).values({
        id,
        kind: parsed.data.kind,
        label: parsed.data.label,
        encryptedToken: encryptSecret(ctx.masterKey, parsed.data.token),
        defaultAgentId: parsed.data.defaultAgentId ?? null,
        allowedChatsJson: parsed.data.allowedChats?.length ? JSON.stringify(parsed.data.allowedChats) : null,
        enabled: true,
        createdAt: new Date(),
      });
      await ctx.channels.reload();
      return reply.code(201).send({ id, botLabel });
    });

    instance.patch("/api/channels/:id", async (request, reply) => {
      if (!requireAdmin(request)) return reply.code(403).send({ error: "Admin only" });
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const rows = await ctx.db.select().from(channelConfigs).where(eq(channelConfigs.id, id)).limit(1);
      const existing = rows[0];
      if (!existing) return reply.code(404).send({ error: "Channel not found" });

      const patch: Partial<typeof channelConfigs.$inferInsert> = {};
      if (parsed.data.label !== undefined) patch.label = parsed.data.label;
      if (parsed.data.token !== undefined) {
        try {
          await verifyToken(existing.kind, parsed.data.token);
        } catch (err) {
          return reply.code(400).send({ error: `Token rejected by ${existing.kind}: ${(err as Error).message}` });
        }
        patch.encryptedToken = encryptSecret(ctx.masterKey, parsed.data.token);
      }
      if (parsed.data.defaultAgentId !== undefined) {
        if (parsed.data.defaultAgentId) {
          const agentRows = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, parsed.data.defaultAgentId)).limit(1);
          if (!agentRows[0]) return reply.code(400).send({ error: "Default agent not found" });
        }
        patch.defaultAgentId = parsed.data.defaultAgentId;
      }
      if (parsed.data.allowedChats !== undefined) {
        patch.allowedChatsJson = parsed.data.allowedChats?.length ? JSON.stringify(parsed.data.allowedChats) : null;
      }
      if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;

      await ctx.db.update(channelConfigs).set(patch).where(eq(channelConfigs.id, id));
      await ctx.channels.reload();
      return { ok: true };
    });

    instance.delete("/api/channels/:id", async (request, reply) => {
      if (!requireAdmin(request)) return reply.code(403).send({ error: "Admin only" });
      const { id } = request.params as { id: string };
      await ctx.db.delete(channelBindings).where(eq(channelBindings.channelId, id));
      await ctx.db.delete(channelConfigs).where(eq(channelConfigs.id, id));
      await ctx.channels.reload();
      return { ok: true };
    });

    /** Re-check the token against the live API without changing anything. */
    instance.post("/api/channels/:id/test", async (request, reply) => {
      if (!requireAdmin(request)) return reply.code(403).send({ error: "Admin only" });
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(channelConfigs).where(eq(channelConfigs.id, id)).limit(1);
      const existing = rows[0];
      if (!existing) return reply.code(404).send({ error: "Channel not found" });
      try {
        const botLabel = await verifyToken(existing.kind, decryptSecret(ctx.masterKey, existing.encryptedToken));
        return { ok: true, botLabel, running: ctx.channels.isRunning(id) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message, running: ctx.channels.isRunning(id) });
      }
    });
  });
}
