import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requireAuth } from "../auth/plugin.js";
import {
  createVaultCredential,
  deleteVaultCredential,
  getVaultCredentialMeta,
  listVaultCredentials,
  updateVaultCredential,
} from "../secrets/vault.js";
import { revokeVaultGrantsForCredential } from "../secrets/vault-grants.js";

const createSchema = z.object({
  service: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  username: z.string().min(1).max(200),
  secret: z.string().min(1).max(10000),
  note: z.string().max(2000).optional().nullable(),
});

const patchSchema = z.object({
  service: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(200).optional(),
  username: z.string().min(1).max(200).optional(),
  secret: z.string().min(1).max(10000).optional(),
  note: z.string().max(2000).optional().nullable(),
});

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.user?.role !== "admin") {
    void reply.code(403).send({ error: "Trezor může spravovat jen administrátor" });
    return false;
  }
  return true;
}

/**
 * Credential vault (Trezor) — admin only. Every response carries metadata
 * ONLY (id, service, label, username, note, dates); the secret is accepted on
 * write, encrypted server-side with the master key, and never sent back.
 */
export function registerVaultRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/vault", async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      return { credentials: await listVaultCredentials(ctx.db) };
    });

    instance.post("/api/vault", async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Zkontroluj vyplněná pole (služba, název, uživatelské jméno a heslo jsou povinné)" });
      try {
        const created = await createVaultCredential(ctx.db, ctx.masterKey, parsed.data, request.user!.id);
        await ctx.audit.record({
          actorId: request.user!.id,
          actorType: "user",
          action: "vault.create",
          target: created.id,
          targetType: "vault_credential",
          result: "allowed",
          detail: { service: created.service, label: created.label, username: created.username },
        });
        return reply.code(201).send(created);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    instance.patch("/api/vault/:id", async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { id } = request.params as { id: string };
      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Neplatná data" });
      try {
        const updated = await updateVaultCredential(ctx.db, ctx.masterKey, id, parsed.data);
        if (!updated) return reply.code(404).send({ error: "Údaj nenalezen" });
        await ctx.audit.record({
          actorId: request.user!.id,
          actorType: "user",
          action: "vault.update",
          target: updated.id,
          targetType: "vault_credential",
          result: "allowed",
          detail: {
            service: updated.service,
            label: updated.label,
            username: updated.username,
            secretRotated: parsed.data.secret !== undefined,
          },
        });
        return updated;
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    instance.delete("/api/vault/:id", async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { id } = request.params as { id: string };
      const meta = await getVaultCredentialMeta(ctx.db, id);
      const ok = await deleteVaultCredential(ctx.db, id);
      if (!ok) return reply.code(404).send({ error: "Údaj nenalezen" });
      // A deleted credential must not stay fillable through an issued grant.
      revokeVaultGrantsForCredential(id);
      await ctx.audit.record({
        actorId: request.user!.id,
        actorType: "user",
        action: "vault.delete",
        target: id,
        targetType: "vault_credential",
        result: "allowed",
        detail: meta ? { service: meta.service, label: meta.label, username: meta.username } : undefined,
      });
      return { ok: true };
    });
  });
}
