import { asc, eq } from "drizzle-orm";
import type { AgentLoopManager, PersistencePort } from "@kuclab-hertz/core";
import { repairSessionHistory } from "@kuclab-hertz/core";
import type { Database } from "./db/client.js";
import { newId } from "./db/client.js";
import { agents, projectRoots, sessionParticipants, sessions } from "./db/schema.js";
import type { SandboxRegistry } from "./sandbox/sandbox-registry.js";
import type { HertzPaths } from "./paths.js";
import { employeeDir, ensureEmployeeDirs } from "./paths.js";
import { buildSystemPrompt } from "./agents/system-prompt.js";

/**
 * Messenger-style group chats: multiple bots share one thread with the user.
 * When a message lands, every participant answers in sequence — or only those
 * @mentioned by name ("@Atlas find flights, @Lens draft the post"). Each bot
 * sees everything said before its turn (shared history), replies inline like
 * a normal chat message, and the user watches the collaboration live.
 */

export interface GroupDeps {
  db: Database;
  paths: HertzPaths;
  sandboxRegistry: SandboxRegistry;
  persistence: PersistencePort;
  agentLoop: AgentLoopManager;
  fallbackUserId: () => Promise<string>;
}

export async function createGroupSession(
  deps: Pick<GroupDeps, "db">,
  args: { projectId: string; title: string; agentIds: string[] },
): Promise<string> {
  const now = new Date();
  const sessionId = newId();
  await deps.db.insert(sessions).values({
    id: sessionId,
    agentId: args.agentIds[0]!,
    projectId: args.projectId,
    title: args.title,
    kind: "group",
    mode: "autonomous",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await deps.db.insert(sessionParticipants).values(
    args.agentIds.map((agentId) => ({ id: newId(), sessionId, agentId, createdAt: now })),
  );
  return sessionId;
}

export async function listGroupParticipants(db: Database, sessionId: string): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: agents.id, name: agents.name })
    .from(sessionParticipants)
    .innerJoin(agents, eq(sessionParticipants.agentId, agents.id))
    .where(eq(sessionParticipants.sessionId, sessionId))
    .orderBy(asc(sessionParticipants.createdAt));
}

/** Parses "@Name" mentions against participant names (case-insensitive substring match); no match = everyone answers. */
export function resolveMentions(participants: Array<{ id: string; name: string }>, text: string): Array<{ id: string; name: string }> {
  const mentionTokens = (text.match(/@([\p{L}\p{N}_-]+)/gu) ?? []).map((m) => m.slice(1).toLowerCase());
  if (mentionTokens.length === 0) return participants;
  const matched = participants.filter((p) =>
    mentionTokens.some((token) => p.name.toLowerCase().includes(token)),
  );
  return matched.length > 0 ? matched : participants;
}

/** Runs one group round: each selected participant answers the shared thread in turn. */
export async function runGroupTurn(deps: GroupDeps, sessionId: string, triggerText: string, forcedAgentId?: string): Promise<void> {
  const { db, paths, sandboxRegistry, persistence, agentLoop } = deps;

  const sessionRows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const session = sessionRows[0];
  if (!session || session.status === "archived") return;

  let responders = await listGroupParticipants(db, sessionId);
  if (forcedAgentId) {
    responders = responders.filter((p) => p.id === forcedAgentId);
  } else {
    responders = resolveMentions(responders, triggerText);
  }
  if (responders.length === 0) return;

  const rootRows = await db.select().from(projectRoots).where(eq(projectRoots.projectId, session.projectId));
  const mainRoot = rootRows.find((r) => r.rootId === "main") ?? rootRows[0];
  if (!mainRoot) throw new Error(`Project ${session.projectId} has no root directory configured`);

  await repairSessionHistory(persistence, sessionId);

  for (const participant of responders) {
    // A previous participant may have parked the thread with an ask_user /
    // approval question — stop the round there until the human answers.
    const statusRows = await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (statusRows[0]?.status !== "active" && statusRows[0]?.status !== "completed") break;

    const agentRows = await db.select().from(agents).where(eq(agents.id, participant.id)).limit(1);
    const agent = agentRows[0];
    if (!agent || agent.approvalStatus !== "approved" || agent.status === "terminated") continue;

    await ensureEmployeeDirs(paths, session.projectId, agent.id);
    sandboxRegistry.register(sessionId, {
      [mainRoot.rootId]: mainRoot.absolutePath,
      self: employeeDir(paths, session.projectId, agent.id),
    });

    await db.update(sessions).set({ status: "active", updatedAt: new Date() }).where(eq(sessions.id, sessionId));

    try {
      await agentLoop.runToCompletion(
        {
          sessionId,
          agentId: agent.id,
          projectId: session.projectId,
          userId: await deps.fallbackUserId(),
          rootId: mainRoot.rootId,
          model: agent.model,
          providerConfigId: agent.providerConfigId,
          systemPrompt: await buildSystemPrompt(db, agent, { paths, mode: "autonomous" }),
          mode: "autonomous",
          excludeTools: ["message_employee", "hire_employee"],
        },
        [],
      );
    } catch {
      // One failing participant shouldn't kill the whole round.
    }
  }

  await db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, sessionId));
}
