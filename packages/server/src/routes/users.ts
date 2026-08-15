import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { users } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { hashPassword, verifyPassword } from "../auth/password.js";

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["admin", "user"]).default("user"),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8),
});

const changeRoleSchema = z.object({ role: z.enum(["admin", "user"]) });

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/users", { preHandler: requireAdmin }, async () => {
      const rows = await ctx.db.select({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt }).from(users);
      return { users: rows };
    });

    instance.post("/api/users", { preHandler: requireAdmin }, async (request, reply) => {
      const parsed = createUserSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const existing = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, parsed.data.email)).limit(1);
      if (existing.length > 0) return reply.code(400).send({ error: "That email is already in use" });

      const id = newId();
      await ctx.db.insert(users).values({
        id,
        email: parsed.data.email,
        passwordHash: await hashPassword(parsed.data.password),
        role: parsed.data.role,
        createdAt: new Date(),
      });
      return reply.code(201).send({ id });
    });

    instance.patch("/api/users/:id/role", { preHandler: requireAdmin }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = changeRoleSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (id === request.user!.id && parsed.data.role !== "admin") {
        return reply.code(400).send({ error: "You can't demote yourself" });
      }

      const rows = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "User not found" });

      await ctx.db.update(users).set({ role: parsed.data.role }).where(eq(users.id, id));
      return { ok: true };
    });

    // Self can change their own password (must prove they know the current one); an
    // admin resetting someone else's doesn't need to — they're already trusted.
    instance.patch("/api/users/:id/password", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

      const isSelf = id === request.user!.id;
      if (!isSelf && request.user!.role !== "admin") {
        return reply.code(403).send({ error: "You can only change your own password" });
      }

      const rows = await ctx.db.select().from(users).where(eq(users.id, id)).limit(1);
      const user = rows[0];
      if (!user) return reply.code(404).send({ error: "User not found" });

      if (isSelf) {
        if (!parsed.data.currentPassword || !(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
          return reply.code(400).send({ error: "Current password is incorrect" });
        }
      }

      await ctx.db.update(users).set({ passwordHash: await hashPassword(parsed.data.newPassword) }).where(eq(users.id, id));
      return { ok: true };
    });

    instance.delete("/api/users/:id", { preHandler: requireAdmin }, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (id === request.user!.id) return reply.code(400).send({ error: "You can't delete your own account" });

      const rows = await ctx.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "User not found" });

      if (rows[0].role === "admin") {
        const admins = await ctx.db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
        if (admins.length <= 1) return reply.code(400).send({ error: "Can't delete the last admin account" });
      }

      // Deletes session_tokens and project_members rows via ON DELETE CASCADE.
      await ctx.db.delete(users).where(eq(users.id, id));
      return reply.code(204).send();
    });
  });
}
