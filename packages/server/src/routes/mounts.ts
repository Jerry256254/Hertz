import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agents, mounts, projectRoots } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { hasProjectAccess } from "../auth/project-access.js";
import { validateMountName } from "../mounts/mounts.js";

const createSchema = z.object({
  name: z.string().min(1).max(32),
  hostPath: z.string().min(1),
  purpose: z.string().max(500).optional(),
  /** Null/omitted = whole project; otherwise scoped to one agent. */
  agentId: z.string().min(1).nullable().optional(),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(32).optional(),
    purpose: z.string().max(500).nullable().optional(),
  })
  .strict();

export function registerMountRoutes(app: FastifyInstance, ctx: Pick<AppContext, "db" | "audit">): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    /** List mounts for a project — any member may see; includes the built-in project folder. */
    instance.get("/api/projects/:id/mounts", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await hasProjectAccess(ctx.db, request.user!, id))) {
        return reply.code(403).send({ error: "No access to this project" });
      }
      const rows = await ctx.db
        .select()
        .from(mounts)
        .where(eq(mounts.projectId, id))
        .orderBy(mounts.name);
      // V1: project_roots(main) stays the source of truth — shown here as the
      // built-in mount so the UI renders one uniform folder list (no migration).
      const roots = await ctx.db
        .select()
        .from(projectRoots)
        .where(eq(projectRoots.projectId, id));
      const main = roots.find((r) => r.rootId === "main") ?? roots[0];
      return {
        mounts: rows,
        builtIn: main ? { name: "main", hostPath: main.absolutePath, purpose: "Project files" } : null,
      };
    });

    /** Create a mount — admins only (mirrors the admin-only fs-browse picker design). */
    instance.post("/api/projects/:id/mounts", { preHandler: requireAdmin }, async (request, reply) => {
      const { id: projectId } = request.params as { id: string };
      if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) {
        return reply.code(403).send({ error: "No access to this project" });
      }
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const nameError = validateMountName(parsed.data.name);
      if (nameError) return reply.code(400).send({ error: nameError });

      if (!path.isAbsolute(parsed.data.hostPath)) {
        return reply.code(400).send({ error: "hostPath must be an absolute path" });
      }
      let hostPath: string;
      try {
        hostPath = await fs.realpath(parsed.data.hostPath);
        const stat = await fs.stat(hostPath);
        if (!stat.isDirectory()) throw new Error("not a directory");
      } catch (err) {
        return reply.code(400).send({ error: `Invalid host path: ${(err as Error).message}` });
      }

      const agentId = parsed.data.agentId ?? null;
      if (agentId) {
        const aRows = await ctx.db
          .select({ id: agents.id, projectId: agents.projectId })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1);
        if (!aRows[0] || aRows[0].projectId !== projectId) {
          return reply.code(400).send({ error: "agentId must belong to this project" });
        }
      }

      const dup = await ctx.db
        .select({ id: mounts.id })
        .from(mounts)
        .where(and(eq(mounts.projectId, projectId), eq(mounts.name, parsed.data.name)))
        .limit(1);
      if (dup.length > 0) return reply.code(409).send({ error: `A mount named '${parsed.data.name}' already exists in this project` });

      const mountId = newId();
      await ctx.db.insert(mounts).values({
        id: mountId,
        projectId,
        agentId,
        name: parsed.data.name,
        hostPath,
        purpose: parsed.data.purpose?.trim() ? parsed.data.purpose.trim() : null,
        createdByUserId: request.user!.id,
        createdAt: new Date(),
      });
      await ctx.audit.record({
        actorId: request.user!.id,
        actorType: "user",
        projectId,
        action: "mount.create",
        target: mountId,
        targetType: "mount",
        result: "allowed",
        detail: { name: parsed.data.name, hostPath },
      });
      // Containers pick the fresh mount set up via syncMounts on the next run;
      // a running container is recreated automatically, nothing else to do here.
      return reply.code(201).send({ id: mountId });
    });

    /** Rename / re-describe a mount — hostPath is immutable (delete + recreate to move). */
    instance.patch("/api/mounts/:mountId", { preHandler: requireAdmin }, async (request, reply) => {
      const { mountId } = request.params as { mountId: string };
      if (request.body !== null && typeof request.body === "object" && "hostPath" in (request.body as Record<string, unknown>)) {
        return reply.code(400).send({ error: "hostPath is immutable — delete the mount and create a new one to move it" });
      }
      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (parsed.data.name === undefined && parsed.data.purpose === undefined) {
        return reply.code(400).send({ error: "Nothing to update" });
      }

      const rows = await ctx.db.select().from(mounts).where(eq(mounts.id, mountId)).limit(1);
      const mount = rows[0];
      if (!mount) return reply.code(404).send({ error: "Mount not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, mount.projectId))) {
        return reply.code(403).send({ error: "No access to this project" });
      }

      if (parsed.data.name !== undefined) {
        const nameError = validateMountName(parsed.data.name);
        if (nameError) return reply.code(400).send({ error: nameError });
        if (parsed.data.name !== mount.name) {
          const dup = await ctx.db
            .select({ id: mounts.id })
            .from(mounts)
            .where(and(eq(mounts.projectId, mount.projectId), eq(mounts.name, parsed.data.name)))
            .limit(1);
          if (dup.length > 0) return reply.code(409).send({ error: `A mount named '${parsed.data.name}' already exists in this project` });
        }
      }

      const patch: Partial<typeof mount> = {};
      if (parsed.data.name !== undefined) patch.name = parsed.data.name;
      if (parsed.data.purpose !== undefined) patch.purpose = parsed.data.purpose?.trim() ? parsed.data.purpose.trim() : null;
      await ctx.db.update(mounts).set(patch).where(eq(mounts.id, mountId));
      await ctx.audit.record({
        actorId: request.user!.id,
        actorType: "user",
        projectId: mount.projectId,
        action: "mount.update",
        target: mountId,
        targetType: "mount",
        result: "allowed",
        detail: { name: patch.name ?? mount.name, hostPath: mount.hostPath },
      });
      return { ok: true };
    });

    /** Delete a mount — admins only. */
    instance.delete("/api/mounts/:mountId", { preHandler: requireAdmin }, async (request, reply) => {
      const { mountId } = request.params as { mountId: string };
      const rows = await ctx.db.select().from(mounts).where(eq(mounts.id, mountId)).limit(1);
      const mount = rows[0];
      if (!mount) return reply.code(404).send({ error: "Mount not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, mount.projectId))) {
        return reply.code(403).send({ error: "No access to this project" });
      }
      await ctx.db.delete(mounts).where(eq(mounts.id, mountId));
      await ctx.audit.record({
        actorId: request.user!.id,
        actorType: "user",
        projectId: mount.projectId,
        action: "mount.delete",
        target: mountId,
        targetType: "mount",
        result: "allowed",
        detail: { name: mount.name, hostPath: mount.hostPath },
      });
      return reply.code(204).send();
    });
  });
}
