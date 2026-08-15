import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { projectMembers, projectRoots, projects, sessions, users } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth, requireAdmin } from "../auth/plugin.js";
import { accessibleProjectIds, hasProjectAccess } from "../auth/project-access.js";

const memberSchema = z.object({ userId: z.string().min(1) });
const autoApproveSchema = z.object({ autoApprove: z.boolean() });

const createSchema = z.object({
  name: z.string().min(1),
  rootPath: z.string().min(1),
});

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.post("/api/projects", async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      let absolutePath: string;
      try {
        absolutePath = await fs.realpath(parsed.data.rootPath);
        const stat = await fs.stat(absolutePath);
        if (!stat.isDirectory()) throw new Error("not a directory");
      } catch (err) {
        return reply.code(400).send({ error: `Invalid root path: ${(err as Error).message}` });
      }

      const projectId = newId();
      const now = new Date();
      await ctx.db.insert(projects).values({ id: projectId, name: parsed.data.name, createdAt: now });
      await ctx.db.insert(projectRoots).values({
        id: newId(),
        projectId,
        rootId: "main",
        label: parsed.data.name,
        absolutePath,
      });
      // A non-admin who creates a project automatically gets access to it — admins
      // already see everything, so this only matters for regular-user accounts.
      if (request.user!.role !== "admin") {
        await ctx.db.insert(projectMembers).values({ id: newId(), projectId, userId: request.user!.id, createdAt: now });
      }
      return reply.code(201).send({ id: projectId });
    });

    instance.get("/api/projects", async (request) => {
      const accessible = await accessibleProjectIds(ctx.db, request.user!);
      const rows = accessible === "all" ? await ctx.db.select().from(projects) : await ctx.db.select().from(projects).where(inArray(projects.id, [...accessible]));
      const roots = await ctx.db.select().from(projectRoots);
      return {
        projects: rows.map((p) => ({
          ...p,
          roots: roots.filter((r) => r.projectId === p.id),
        })),
      };
    });

    instance.get("/api/projects/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await hasProjectAccess(ctx.db, request.user!, id))) return reply.code(403).send({ error: "No access to this project" });
      const rows = await ctx.db.select().from(projects).where(eq(projects.id, id)).limit(1);
      const project = rows[0];
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const roots = await ctx.db.select().from(projectRoots).where(eq(projectRoots.projectId, id));
      return { ...project, roots };
    });

    instance.get("/api/projects/:id/members", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await hasProjectAccess(ctx.db, request.user!, id))) return reply.code(403).send({ error: "No access to this project" });
      const rows = await ctx.db
        .select({ id: projectMembers.id, userId: users.id, email: users.email, role: users.role })
        .from(projectMembers)
        .innerJoin(users, eq(projectMembers.userId, users.id))
        .where(eq(projectMembers.projectId, id));
      return { members: rows };
    });

    instance.post("/api/projects/:id/members", { preHandler: requireAdmin }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = memberSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const existing = await ctx.db
        .select({ id: projectMembers.id })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, parsed.data.userId)))
        .limit(1);
      if (existing.length === 0) {
        await ctx.db.insert(projectMembers).values({ id: newId(), projectId: id, userId: parsed.data.userId, createdAt: new Date() });
      }
      return reply.code(201).send({ ok: true });
    });

    instance.delete("/api/projects/:id/members/:userId", { preHandler: requireAdmin }, async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      await ctx.db.delete(projectMembers).where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)));
      return reply.code(204).send();
    });

    // Toggling this lets the manager's hire_employee/fire_employee take effect
    // immediately instead of waiting for the user (CEO) to approve each one.
    instance.patch("/api/projects/:id/auto-approve", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = autoApproveSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (!(await hasProjectAccess(ctx.db, request.user!, id))) return reply.code(403).send({ error: "No access to this project" });

      await ctx.db.update(projects).set({ autoApprove: parsed.data.autoApprove }).where(eq(projects.id, id));
      return { ok: true };
    });

    instance.delete("/api/projects/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await hasProjectAccess(ctx.db, request.user!, id))) return reply.code(403).send({ error: "No access to this project" });
      const rows = await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Project not found" });

      const sessionRows = await ctx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.projectId, id));
      if (sessionRows.some((s) => ctx.agentLoop.isRunning(s.id))) {
        return reply.code(409).send({ error: "Can't delete a project while one of its sessions is running" });
      }

      // Deletes projectRoots/agents/sessions/messages/meetings via ON DELETE CASCADE.
      await ctx.db.delete(projects).where(eq(projects.id, id));
      return reply.code(204).send();
    });
  });
}
