import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { agentMemory, agentMemoryAtoms, agentMemoryScenarios, agents, approvals, channelBindings, employeeShellGrants, employeeShells, mcpServers, messages, mounts, projectRoots, sessions } from "../db/schema.js";
import { newId } from "../db/client.js";
import { requireAuth } from "../auth/plugin.js";
import { hasProjectAccess } from "../auth/project-access.js";
import { employeeDir, ensureEmployeeDirs } from "../paths.js";
import { mountsFor } from "../mounts/mounts.js";
import { deleteSkillFile, readSkillFile, skillsIndexFor, writeSkillFile, type SkillFile } from "../tools/skill-tools.js";
import { ensureDefaultSkills } from "../skills/default-skills.js";
import { forgetById, loadPersona } from "../memory/recall.js";
import { removeAgentVectors, removeAtomVector } from "../memory/vector-store.js";
import { ensureAgent } from "../bootstrap.js";
import { ensureDefaultProject } from "../projects/default-project.js";
import { parseAvatarSpec, avatarSvgForAgent } from "../agents/avatar.js";

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  model: z.string().min(1).optional(),
  providerConfigId: z.string().min(1).optional(),
  systemPrompt: z.string().max(20_000).nullable().optional(),
  // VM-only isolation: the API can only select 'docker'. Pre-existing 'local'
  // rows are grandfathered (they keep working) but cannot be created anew.
  computerBackend: z.enum(["docker"]).optional(),
  computerImage: z.string().min(1).nullable().optional(),
  /** Proactive self-wake interval; 0 disables heartbeats. */
  heartbeatMinutes: z.number().int().min(0).max(10080).optional(),
  heartbeatPrompt: z.string().max(4000).nullable().optional(),
  /** Avatar style seed shown as the agent's animated avatar everywhere. */
  mascot: z.string().min(1).max(8).nullable().optional(),
  /**
   * Generative avatar spec (JSON string: { version, kind, seed }) — the agent's
   * unique visual identity, rendered as SVG. Minted at onboarding; the agent can
   * re-roll it with the regenerate_avatar tool.
   */
  avatar: z.string().min(1).max(20_000).nullable().optional(),
  /** Krátká charakteristika agenta — "kým je" (editovatelný profil identity). */
  character: z.string().max(200).nullable().optional(),
  /** Jak agent působí — tón, energie, nálada (editovatelný profil identity). */
  vibe: z.string().max(200).nullable().optional(),
  /** Duše agenta (SOUL.md) — trvalý text identity; agent ji čte v system promptu a sám ji přepisuje. */
  soul: z.string().max(20_000).nullable().optional(),
  /** Trvalý obraz uživatele (USER.md) — jméno, oslovení, co má rád, hranice. */
  userProfile: z.string().max(20_000).nullable().optional(),
});

const ensureChatSchema = z.object({ projectId: z.string().min(1) });

const skillSaveSchema = z.object({
  description: z.string().min(1).max(200),
  instructions: z.string().min(1).max(50_000),
  script: z.string().max(50_000).optional(),
});

const ensureAgentSchema = z.object({
  /** Omitted → the single implicit workspace project is used/created. */
  projectId: z.string().min(1).optional(),
  providerConfigId: z.string().min(1),
  model: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
});

/** Minimal agent lookup for the per-skill routes. */
async function skillAgent(ctx: AppContext, id: string): Promise<{ id: string; projectId: string } | undefined> {
  const rows = await ctx.db.select({ id: agents.id, projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
  return rows[0];
}

/** Container bind-mount set for an agent: project root + personal dir + permanent mounts (via the one mountsFor helper). */
export async function containerMounts(ctx: AppContext, agent: { id: string; projectId: string }): Promise<string[]> {
  const rootRows = await ctx.db.select({ absolutePath: projectRoots.absolutePath }).from(projectRoots).where(eq(projectRoots.projectId, agent.projectId));
  const mainRoot = rootRows[0]?.absolutePath;
  await ensureEmployeeDirs(ctx.paths, agent.projectId, agent.id);
  const mountRows = await mountsFor(ctx.db, agent.projectId, agent.id);
  return [...new Set([...(mainRoot ? [mainRoot] : []), employeeDir(ctx.paths, agent.projectId, agent.id), ...mountRows.map((m) => m.hostPath)])];
}

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  void app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    /** The single agent — bootstrapped on first setup, exactly one row. */
    instance.get("/api/agent", async (_request, reply) => {
      const rows = await ctx.db.select().from(agents).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "No agent yet — complete setup first" });
      // Honest isolation labelling for grandfathered local-backend agents.
      return { ...rows[0], isolated: rows[0].computerBackend === "docker" };
    });

    /** Idempotent bootstrap: returns the agent, creating it on first call (setup wizard). */
    instance.post("/api/agent/ensure", async (request, reply) => {
      const parsed = ensureAgentSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      // No project picker in the UI anymore — the agent lives in the one
      // implicit workspace; an explicit projectId is still honored for API/CLI callers.
      const projectId = parsed.data.projectId ?? (await ensureDefaultProject(ctx));
      if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) {
        return reply.code(403).send({ error: "No access to this project" });
      }
      if (parsed.data.providerConfigId) {
        const { providerConfigs } = await import("../db/schema.js");
        const pc = await ctx.db.select({ id: providerConfigs.id }).from(providerConfigs).where(eq(providerConfigs.id, parsed.data.providerConfigId)).limit(1);
        if (!pc[0]) return reply.code(400).send({ error: "Zvolený provider neexistuje — vyberte jiný model v nastavení" });
      }
      const id = await ensureAgent(ctx, { ...parsed.data, projectId });
      // Newborn agents start with the default procedures (missing-only, idempotent).
      await ensureDefaultSkills(ctx.paths, projectId, id).catch(() => {});
      return reply.code(201).send({ id });
    });

    // The user changing the agent's character — name, model/provider, soul prompt, avatar.
    instance.patch("/api/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: "Nothing to update" });

      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (parsed.data.avatar && !parseAvatarSpec(parsed.data.avatar)) {
        return reply.code(400).send({ error: "Neplatný avatar spec — očekáváno JSON { version: 1, kind: \"generative\", seed }" });
      }
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) {
        return reply.code(403).send({ error: "No access to this project" });
      }
      if (parsed.data.providerConfigId) {
        const { providerConfigs } = await import("../db/schema.js");
        const pc = await ctx.db.select({ id: providerConfigs.id, userId: providerConfigs.userId }).from(providerConfigs).where(eq(providerConfigs.id, parsed.data.providerConfigId)).limit(1);
        if (!pc[0]) return reply.code(400).send({ error: "Provider config not found" });
        // A project member must not burn someone else's API key/quota.
        if (pc[0].userId !== request.user!.id && request.user!.role !== "admin")
          return reply.code(403).send({ error: "This provider belongs to another user" });
      }

      await ctx.db.update(agents).set(parsed.data).where(eq(agents.id, id));
      return { ok: true };
    });

    /**
     * The agent's generative avatar as standalone SVG (deterministic per spec).
     * Usable directly as an <img> source; falls back to a stable generated
     * motif when the agent has no stored spec yet.
     */
    instance.get("/api/agents/:id/avatar.svg", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db
        .select({ id: agents.id, projectId: agents.projectId, avatar: agents.avatar })
        .from(agents)
        .where(eq(agents.id, id))
        .limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) {
        return reply.code(403).send({ error: "No access" });
      }
      const svg = avatarSvgForAgent(agent.avatar, agent.id);
      // The URL is constant per agent, so without cache headers the browser
      // would keep showing a stale cached copy after regenerate_avatar.
      // ETag = the stored spec (changes on every re-roll): revalidation is
      // cheap (304 while unchanged) and a new avatar always yields new bytes.
      const etag = `"${createHash("sha256").update(agent.avatar ?? `agent:${agent.id}`).digest("hex").slice(0, 32)}"`;
      if (request.headers["if-none-match"] === etag) {
        return reply.code(304).send();
      }
      return reply
        .header("content-type", "image/svg+xml; charset=utf-8")
        .header("etag", etag)
        .header("cache-control", "no-cache")
        .send(svg);
    });

    /**
     * Re-roll the agent's generative avatar (server-side twin of the agent's
     * regenerate_avatar tool) — used by the identity profile editor in the UI.
     */
    instance.post("/api/agents/:id/avatar/regenerate", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db
        .select({ id: agents.id, projectId: agents.projectId, name: agents.name })
        .from(agents)
        .where(eq(agents.id, id))
        .limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) {
        return reply.code(403).send({ error: "No access" });
      }
      const { generateAvatarSpec } = await import("../agents/avatar.js");
      // Mint until the seed actually differs, then verify the write landed —
      // never report success while the avatar is unchanged (same guarantee
      // as the agent's regenerate_avatar tool).
      const prevSeed = parseAvatarSpec(
        (await ctx.db.select({ avatar: agents.avatar }).from(agents).where(eq(agents.id, id)).limit(1))[0]?.avatar,
      )?.seed;
      let spec = generateAvatarSpec(agent.name ?? "agent");
      for (let i = 0; i < 5 && spec.seed === prevSeed; i++) {
        spec = generateAvatarSpec(agent.name ?? "agent");
      }
      if (spec.seed === prevSeed) {
        return reply.code(500).send({ error: "Nepodařilo se vygenerovat odlišný avatar." });
      }
      await ctx.db
        .update(agents)
        .set({ avatar: JSON.stringify(spec) })
        .where(eq(agents.id, id));
      const check = await ctx.db
        .select({ avatar: agents.avatar })
        .from(agents)
        .where(eq(agents.id, id))
        .limit(1);
      if (parseAvatarSpec(check[0]?.avatar)?.seed !== spec.seed) {
        return reply.code(500).send({ error: "Avatar se nepodařilo uložit do databáze." });
      }
      return { ok: true };
    });

    /** Status of the agent's own computer — auto-creates the container when missing. */
    instance.get("/api/agents/:id/computer", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) return reply.code(403).send({ error: "No access" });

      const dockerState = await ctx.computer.status(id);
      if (dockerState === "unavailable") {
        return { backend: "docker", status: "unavailable", image: agent.computerImage ?? null, containerName: ctx.computer.containerName(id) };
      }

      // Auto-setup: no container yet (or stopped) → bring it up right here.
      // A running container is reconciled too — syncMounts recreates it only
      // when the mount set drifted from the DB.
      try {
        await ctx.computer.ensureContainer({
          agentId: agent.id,
          image: agent.computerImage,
          mountPaths: await containerMounts(ctx, agent),
        });
        if (dockerState === "missing" || dockerState === "stopped") {
          void ctx.desktop.start(agent.id).catch(() => {});
        }
      } catch (err) {
        return { backend: "docker", status: dockerState, image: agent.computerImage ?? null, containerName: ctx.computer.containerName(id), error: (err as Error).message };
      }

      const state = await ctx.computer.status(id);
      return { backend: "docker", status: state, image: agent.computerImage ?? null, containerName: ctx.computer.containerName(id) };
    });

    /** Restart (recreate) the agent's computer — e.g. after a broken state or to pick up a new image. */
    instance.post("/api/agents/:id/computer/restart", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) return reply.code(403).send({ error: "No access" });
      if (agent.computerBackend !== "docker") {
        return reply.code(400).send({ error: "This agent runs locally — nothing to restart" });
      }
      try {
        await ctx.computer.destroyContainer(id);
        await ctx.computer.ensureContainer({
          agentId: agent.id,
          image: agent.computerImage,
          mountPaths: await containerMounts(ctx, agent),
        });
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    });

    /**
     * The main chat: exactly one permanent thread between the user and the
     * agent. Flagged in the DB — never a channel session, never a side chat.
     * Pre-flag installs adopt their oldest unbound session, so the existing
     * main thread survives the upgrade instead of forking a new one.
     */
    instance.post("/api/agents/:id/ensure-chat", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = ensureChatSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const projectId = parsed.data.projectId;

      const agentRows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const agent = agentRows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      // The chat belongs to the agent's own project — a member of another
      // project must not open a cross-project chat with this agent.
      if (projectId !== agent.projectId) return reply.code(400).send({ error: "Project does not match the agent" });
      if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) return reply.code(403).send({ error: "No access to this project" });

      const flagged = await ctx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.agentId, id), eq(sessions.isMainChat, true)))
        .limit(1);
      if (flagged[0]) return { id: flagged[0].id };

      // Adopt the oldest session that isn't owned by a channel (side chats
      // created earlier stay side chats — only one becomes main).
      const boundRows = await ctx.db.select({ sessionId: channelBindings.sessionId }).from(channelBindings);
      const bound = new Set(boundRows.map((b) => b.sessionId));
      const candidates = await ctx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.agentId, id))
        .orderBy(sessions.createdAt)
        .limit(50);
      const adopted = candidates.find((c) => !bound.has(c.id));
      if (adopted) {
        await ctx.db.update(sessions).set({ isMainChat: true }).where(eq(sessions.id, adopted.id));
        return { id: adopted.id };
      }

      const sid = newId();
      const now = new Date();
      await ctx.db.insert(sessions).values({
        id: sid,
        agentId: id,
        projectId,
        title: agent.name,
        mode: "autonomous",
        status: "active",
        isMainChat: true,
        createdAt: now,
        updatedAt: now,
      });
      return reply.code(201).send({ id: sid });
    });

    /** Clears the agent's chat history (messages only — memory and skills stay). Channel sessions belong to external chats and are left alone. */
    instance.post("/api/agents/:id/clear-chat", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = ensureChatSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const projectId = parsed.data.projectId;
      const agentCheck = await ctx.db.select({ projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!agentCheck[0]) return reply.code(404).send({ error: "Agent not found" });
      if (projectId !== agentCheck[0].projectId) return reply.code(400).send({ error: "Project does not match the agent" });
      if (!(await hasProjectAccess(ctx.db, request.user!, projectId))) return reply.code(403).send({ error: "No access" });

      const boundRows = await ctx.db.select({ sessionId: channelBindings.sessionId }).from(channelBindings);
      const bound = new Set(boundRows.map((b) => b.sessionId));
      const chatRows = (await ctx.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.agentId, id))).filter((s) => !bound.has(s.id));
      for (const s of chatRows) {
        if (ctx.agentLoop.isRunning(s.id)) {
          return reply.code(409).send({ error: "The agent is running — stop it before clearing the chat." });
        }
        await ctx.db.delete(messages).where(eq(messages.sessionId, s.id));
        await ctx.db.update(sessions).set({ status: "active", metadata: null, updatedAt: new Date() }).where(eq(sessions.id, s.id));
      }
      return { ok: true, cleared: chatRows.length };
    });

    /** The agent's personal skill library (index only — full text lives on disk). */
    instance.get("/api/agents/:id/skills", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: agents.id, projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, rows[0].projectId))) return reply.code(403).send({ error: "No access" });
      // First access seeds the defaults (missing-only — agent/user edits win).
      await ensureDefaultSkills(ctx.paths, rows[0].projectId, id).catch(() => {});
      return { skills: await skillsIndexFor(ctx.paths, rows[0].projectId, id) };
    });

    /** Full text of one skill (for the agent-settings UI). */
    instance.get("/api/agents/:id/skills/:name", async (request, reply) => {
      const { id, name } = request.params as { id: string; name: string };
      const agent = await skillAgent(ctx, id);
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) return reply.code(403).send({ error: "No access" });
      let file: SkillFile | null;
      try {
        file = await readSkillFile(ctx.paths, agent.projectId, id, name);
      } catch {
        return reply.code(400).send({ error: "Invalid skill name" });
      }
      if (!file) return reply.code(404).send({ error: "Skill not found" });
      return { skill: file };
    });

    /** Create or overwrite one skill from the agent-settings UI (same semantics as the agent's save_skill). */
    instance.put("/api/agents/:id/skills/:name", async (request, reply) => {
      const { id, name } = request.params as { id: string; name: string };
      const parsed = skillSaveSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const agent = await skillAgent(ctx, id);
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) return reply.code(403).send({ error: "No access" });
      try {
        await writeSkillFile(ctx.paths, agent.projectId, id, name, parsed.data);
      } catch {
        return reply.code(400).send({ error: "Invalid skill name" });
      }
      return { ok: true };
    });

    /** Delete one skill from the agent-settings UI. */
    instance.delete("/api/agents/:id/skills/:name", async (request, reply) => {
      const { id, name } = request.params as { id: string; name: string };
      const agent = await skillAgent(ctx, id);
      if (!agent) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agent.projectId))) return reply.code(403).send({ error: "No access" });
      try {
        await deleteSkillFile(ctx.paths, agent.projectId, id, name);
      } catch {
        return reply.code(400).send({ error: "Invalid skill name" });
      }
      return reply.code(204).send();
    });

    instance.get("/api/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, row.projectId))) return reply.code(403).send({ error: "No access" });
      // Honest isolation labelling for grandfathered local-backend agents.
      return { ...row, isolated: row.computerBackend === "docker" };
    });

    instance.get("/api/agents/:id/memory", async (request, reply) => {
      const { id } = request.params as { id: string };
      const agentRows = await ctx.db.select({ id: agents.id, projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!agentRows[0]) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, agentRows[0].projectId))) return reply.code(403).send({ error: "No access" });

      const [atoms, scenarios, persona, legacy] = await Promise.all([
        ctx.db.select().from(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, id)).orderBy(desc(agentMemoryAtoms.createdAt)).limit(300),
        ctx.db.select().from(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, id)).orderBy(desc(agentMemoryScenarios.updatedAt)).limit(60),
        loadPersona(ctx.paths, agentRows[0].projectId, id).catch(() => ""),
        ctx.db.select().from(agentMemory).where(eq(agentMemory.agentId, id)).orderBy(desc(agentMemory.createdAt)).limit(50),
      ]);
      // `notes` stays for backwards compatibility (atoms mapped to the legacy shape).
      const notes = [
        ...atoms.map((a) => ({ id: a.id, agentId: a.agentId, note: a.text, createdAt: a.createdAt })),
        ...legacy.map((l) => ({ id: l.id, agentId: l.agentId, note: l.note, createdAt: l.createdAt })),
      ];
      return { notes, persona, scenarios, atoms };
    });

    instance.delete("/api/agents/:id/memory/:noteId", async (request, reply) => {
      const { id, noteId } = request.params as { id: string; noteId: string };
      const aRows = await ctx.db.select({ projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
      if (aRows[0] && !(await hasProjectAccess(ctx.db, request.user!, aRows[0].projectId))) return reply.code(403).send({ error: "No access" });
      await forgetById(ctx.db, id, noteId);
      removeAtomVector(ctx.paths, noteId);
      return reply.code(204).send();
    });

    instance.delete("/api/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const rows = await ctx.db.select({ id: agents.id, projectId: agents.projectId }).from(agents).where(eq(agents.id, id)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: "Agent not found" });
      if (!(await hasProjectAccess(ctx.db, request.user!, rows[0].projectId))) return reply.code(403).send({ error: "No access" });

      const sessionRows = await ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.agentId, id));
      if (sessionRows.some((s) => ctx.agentLoop.isRunning(s.id))) {
        return reply.code(409).send({ error: "Can't delete the agent while one of its chats is running" });
      }

      // FK cascades are declared in the schema but not enforced
      // (PRAGMA foreign_keys is off) — clean up dependents manually so no
      // orphan rows or stray containers/desktops are left behind.
      const sessionIds = sessionRows.map((s) => s.id);
      if (sessionIds.length > 0) {
        for (const table of [messages, approvals, channelBindings]) {
          await ctx.db.delete(table).where(inArray(table.sessionId, sessionIds));
        }
        await ctx.db.delete(sessions).where(inArray(sessions.id, sessionIds));
      }
      await ctx.db.delete(approvals).where(eq(approvals.agentId, id));
      await ctx.db.delete(agentMemory).where(eq(agentMemory.agentId, id));
      await ctx.db.delete(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, id));
      await ctx.db.delete(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, id));
      await ctx.db.delete(mounts).where(eq(mounts.agentId, id));
      await ctx.db.delete(mcpServers).where(eq(mcpServers.agentId, id));
      const shellRows = await ctx.db.select({ id: employeeShells.id }).from(employeeShells).where(eq(employeeShells.ownerAgentId, id));
      const shellIds = shellRows.map((s) => s.id);
      if (shellIds.length > 0) {
        await ctx.db.delete(employeeShellGrants).where(inArray(employeeShellGrants.shellId, shellIds));
        await ctx.db.delete(employeeShells).where(inArray(employeeShells.id, shellIds));
      }
      await ctx.db.delete(employeeShellGrants).where(eq(employeeShellGrants.agentId, id));
      await ctx.db.delete(agents).where(eq(agents.id, id));

      removeAgentVectors(ctx.paths, id);
      // Stop the agent's computer resources — orphan containers/desktops
      // would otherwise keep running with no owner.
      await ctx.desktop.stop(id).catch(() => {});
      await ctx.computer.destroyContainer(id).catch(() => {});
      return reply.code(204).send();
    });
  });
}
