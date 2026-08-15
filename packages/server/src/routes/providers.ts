import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createProviderAdapter, SUPPORTED_PROVIDERS, type SupportedProvider } from "@kuclab-hertz/providers";
import type { AppContext } from "../context.js";
import { providerConfigKeys, providerConfigs } from "../db/schema.js";
import { decryptSecret, encryptSecret, maskKey } from "../secrets/key-encryption.js";
import { requireAuth } from "../auth/plugin.js";
import { addProviderConfig } from "../bootstrap.js";
import { newId } from "../db/client.js";

// .trim() before .min(1): a copy-pasted key with a trailing space/newline (very common) silently
// corrupts the "Authorization: Bearer <key>" header downstream and looks exactly like a bad key —
// this was reported as a provider-specific "fix NVIDIA" bug but is a generic paste-hygiene issue.
const createSchema = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS),
  label: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url().optional(),
  defaultModel: z.string().trim().optional(),
});

const addKeySchema = z.object({
  apiKey: z.string().trim().min(1),
});

export function registerProviderRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Registered as a child plugin context so this preHandler hook only scopes to
  // these routes — adding it directly to `app` would leak onto every route
  // sharing this Fastify instance, auth routes included.
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.post("/api/providers", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (parsed.data.provider === "openai-compatible" && !parsed.data.baseUrl) {
        return reply.code(400).send({ error: "baseUrl is required for openai-compatible" });
      }

      const id = await addProviderConfig(ctx, request.user!.id, parsed.data);
      return reply.code(201).send({ id });
    });

    instance.get("/api/providers", async (request) => {
      const rows = await ctx.db
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.userId, request.user!.id));
      const providers = await Promise.all(
        rows.map(async (r) => {
          const pool = await ctx.db
            .select({ id: providerConfigKeys.id })
            .from(providerConfigKeys)
            .where(eq(providerConfigKeys.providerConfigId, r.id));
          return {
            id: r.id,
            provider: r.provider,
            label: r.label,
            baseUrl: r.baseUrl,
            defaultModel: r.defaultModel,
            keyHint: maskKey(decryptSecret(ctx.masterKey, r.encryptedKey)),
            keyCount: 1 + pool.length,
            createdAt: r.createdAt,
          };
        }),
      );
      return { providers };
    });

    instance.get("/api/providers/:id/keys", async (request, reply) => {
      const { id } = request.params as { id: string };
      const owned = await ctx.db
        .select({ id: providerConfigs.id })
        .from(providerConfigs)
        .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, request.user!.id)))
        .limit(1);
      if (!owned[0]) return reply.code(404).send({ error: "Provider not found" });

      const rows = await ctx.db
        .select()
        .from(providerConfigKeys)
        .where(eq(providerConfigKeys.providerConfigId, id));
      return {
        keys: rows.map((r) => ({
          id: r.id,
          keyHint: maskKey(decryptSecret(ctx.masterKey, r.encryptedKey)),
          createdAt: r.createdAt,
        })),
      };
    });

    instance.post("/api/providers/:id/keys", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = addKeySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const owned = await ctx.db
        .select({ id: providerConfigs.id })
        .from(providerConfigs)
        .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, request.user!.id)))
        .limit(1);
      if (!owned[0]) return reply.code(404).send({ error: "Provider not found" });

      const keyId = newId();
      await ctx.db.insert(providerConfigKeys).values({
        id: keyId,
        providerConfigId: id,
        encryptedKey: encryptSecret(ctx.masterKey, parsed.data.apiKey),
        createdAt: new Date(),
      });
      return reply.code(201).send({ id: keyId });
    });

    instance.delete("/api/providers/:id/keys/:keyId", async (request, reply) => {
      const { id, keyId } = request.params as { id: string; keyId: string };
      const owned = await ctx.db
        .select({ id: providerConfigs.id })
        .from(providerConfigs)
        .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, request.user!.id)))
        .limit(1);
      if (!owned[0]) return reply.code(404).send({ error: "Provider not found" });

      await ctx.db
        .delete(providerConfigKeys)
        .where(and(eq(providerConfigKeys.id, keyId), eq(providerConfigKeys.providerConfigId, id)));
      return reply.code(204).send();
    });

    instance.delete("/api/providers/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      await ctx.db
        .delete(providerConfigs)
        .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, request.user!.id)));
      return reply.code(204).send();
    });

    instance.post("/api/providers/:id/scan", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db
        .select()
        .from(providerConfigs)
        .where(and(eq(providerConfigs.id, id), eq(providerConfigs.userId, request.user!.id)))
        .limit(1);
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "Provider not found" });

      const adapter = createProviderAdapter(row.provider as SupportedProvider, {
        apiKey: decryptSecret(ctx.masterKey, row.encryptedKey),
        baseUrl: row.baseUrl ?? undefined,
      });
      try {
        const models = await adapter.listModels();
        return { models };
      } catch (err) {
        return reply.code(502).send({ error: `Model scan failed: ${(err as Error).message}` });
      }
    });
  });
}
