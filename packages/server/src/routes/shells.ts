import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agents, employeeShellGrants, employeeShells, projectRoots } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";

const createSchema = z.object({ name: z.string().min(1) });
const grantSchema = z.object({ agentId: z.string().min(1) });
const runSchema = z.object({ command: z.string().min(1) });

export function registerShellRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/agents/:agentId/shells", async (request, reply) => {
      const { agentId } = request.params as { agentId: string };
      const agentRows = await ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).limit(1);
      if (!agentRows[0]) return reply.code(404).send({ error: "Agent not found" });

      const owned = await ctx.db.select().from(employeeShells).where(eq(employeeShells.ownerAgentId, agentId));
      const grantedRows = await ctx.db
        .select({ shell: employeeShells, ownerName: agents.name })
        .from(employeeShellGrants)
        .innerJoin(employeeShells, eq(employeeShellGrants.shellId, employeeShells.id))
        .innerJoin(agents, eq(employeeShells.ownerAgentId, agents.id))
        .where(eq(employeeShellGrants.agentId, agentId));

      const grants = await ctx.db
        .select({ shellId: employeeShellGrants.shellId, agentName: agents.name })
        .from(employeeShellGrants)
        .innerJoin(agents, eq(employeeShellGrants.agentId, agents.id));
      const sharedWithByShell = new Map<string, string[]>();
      for (const g of grants) {
        const list = sharedWithByShell.get(g.shellId) ?? [];
        list.push(g.agentName);
        sharedWithByShell.set(g.shellId, list);
      }

      return {
        shells: [
          ...owned.map((s) => ({ ...s, owned: true, ownerName: undefined, sharedWith: sharedWithByShell.get(s.id) ?? [], alive: ctx.shellManager.isAlive(s.id) })),
          ...grantedRows.map((r) => ({ ...r.shell, owned: false, ownerName: r.ownerName, sharedWith: [], alive: ctx.shellManager.isAlive(r.shell.id) })),
        ],
      };
    });

    instance.post("/api/agents/:agentId/shells", async (request, reply) => {
      const { agentId } = request.params as { agentId: string };
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const agentRows = await ctx.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
      const agent = agentRows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });

      const id = newId();
      await ctx.db.insert(employeeShells).values({ id, projectId: agent.projectId, ownerAgentId: agentId, name: parsed.data.name, createdAt: new Date() });
      return reply.code(201).send({ id });
    });

    instance.delete("/api/shells/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: employeeShells.id }).from(employeeShells).where(eq(employeeShells.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Shell not found" });

      ctx.shellManager.kill(id);
      await ctx.db.delete(employeeShells).where(eq(employeeShells.id, id));
      return reply.code(204).send();
    });

    instance.post("/api/shells/:id/grant", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = grantSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const rows = await ctx.db.select({ id: employeeShells.id }).from(employeeShells).where(eq(employeeShells.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Shell not found" });

      const existing = await ctx.db
        .select({ id: employeeShellGrants.id })
        .from(employeeShellGrants)
        .where(and(eq(employeeShellGrants.shellId, id), eq(employeeShellGrants.agentId, parsed.data.agentId)))
        .limit(1);
      if (existing.length === 0) {
        await ctx.db.insert(employeeShellGrants).values({ id: newId(), shellId: id, agentId: parsed.data.agentId, createdAt: new Date() });
      }
      return reply.code(201).send({ ok: true });
    });

    instance.delete("/api/shells/:id/grant/:agentId", async (request, reply) => {
      const { id, agentId } = request.params as { id: string; agentId: string };
      await ctx.db.delete(employeeShellGrants).where(and(eq(employeeShellGrants.shellId, id), eq(employeeShellGrants.agentId, agentId)));
      return reply.code(204).send();
    });

    instance.get("/api/shells/:id/buffer", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: employeeShells.id }).from(employeeShells).where(eq(employeeShells.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Shell not found" });
      return { buffer: ctx.shellManager.getBuffer(id), alive: ctx.shellManager.isAlive(id) };
    });

    // The user (CEO) running a command directly in an employee's shell, for oversight/debugging — same
    // ShellManager instance the agent's own run_in_shell tool uses, so it's the exact same live session.
    instance.post("/api/shells/:id/run", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = runSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const shellRows = await ctx.db.select().from(employeeShells).where(eq(employeeShells.id, id)).limit(1);
      const shell = shellRows[0];
      if (!shell) return reply.code(404).send({ error: "Shell not found" });

      const rootRows = await ctx.db.select().from(projectRoots).where(eq(projectRoots.projectId, shell.projectId));
      const mainRoot = rootRows.find((r) => r.rootId === "main") ?? rootRows[0];
      if (!mainRoot) return reply.code(400).send({ error: "Project has no root directory configured" });

      const result = await ctx.shellManager.runCommand(id, mainRoot.absolutePath, parsed.data.command, {
        actorId: request.user!.id,
        actorType: "user",
      });
      return result;
    });
  });
}
