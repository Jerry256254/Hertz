import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { projectRoots, projects } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";

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
      return reply.code(201).send({ id: projectId });
    });

    instance.get("/api/projects", async () => {
      const rows = await ctx.db.select().from(projects);
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
      const rows = await ctx.db.select().from(projects).where(eq(projects.id, id)).limit(1);
      const project = rows[0];
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const roots = await ctx.db.select().from(projectRoots).where(eq(projectRoots.projectId, id));
      return { ...project, roots };
    });
  });
}
