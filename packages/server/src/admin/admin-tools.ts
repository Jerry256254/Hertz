import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentMemory, agentMemoryAtoms, agentMemoryScenarios, agents, sessionTokens, users } from "../db/schema.js";
import type { HertzPaths } from "../paths.js";
import { agentMemoryDir, agentSkillsDir, legacyAgentDir, legacySoulPath } from "../paths.js";
import { resolveAgentProjectId } from "../memory/recall.js";
import { hashPassword } from "../auth/password.js";

/**
 * Headless admin operations for the `hertz` terminal commands (passwd,
 * wipe-memory, factory-reset). Unlike the WebUI routes these run without a
 * booted AppContext — direct DB + filesystem access — so they work even when
 * the server is stopped or the operator is locked out.
 */

export interface AdminUser {
  id: string;
  email: string;
  role: "admin" | "user";
  createdAt: Date;
}

export async function listUsers(db: Database): Promise<AdminUser[]> {
  return db.select({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt }).from(users);
}

/** Sets a user's password hash and kills their web sessions (recovery semantics). */
export async function resetUserPassword(db: Database, userId: string, newPassword: string): Promise<void> {
  await db.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, userId));
  await db.delete(sessionTokens).where(eq(sessionTokens.userId, userId));
}

export interface AdminAgent {
  id: string;
  name: string;
}

export async function listAgents(db: Database): Promise<AdminAgent[]> {
  return db.select({ id: agents.id, name: agents.name }).from(agents);
}

export interface WipeStats {
  atoms: number;
  scenarios: number;
  legacyNotes: number;
  memoryDirRemoved: boolean;
  soulRemoved: boolean;
  skillsRemoved: boolean;
}

/**
 * Completely erases one agent's memory: L1 atoms, L2 scenarios, legacy notes,
 * the on-disk memory pyramid (persona, scenarios, session canvases, state)
 * and the legacy soul.md. Skills survive unless `withSkills` is set — they
 * are reusable procedures, not memory of what happened.
 */
export async function wipeAgentMemory(
  db: Database,
  paths: HertzPaths,
  agentId: string,
  opts: { withSkills?: boolean } = {},
): Promise<WipeStats> {
  const [atomRows, scenarioRows, legacyRows] = await Promise.all([
    db.select({ id: agentMemoryAtoms.id }).from(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, agentId)),
    db.select({ id: agentMemoryScenarios.id }).from(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, agentId)),
    db.select({ id: agentMemory.id }).from(agentMemory).where(eq(agentMemory.agentId, agentId)),
  ]);
  await db.delete(agentMemoryAtoms).where(eq(agentMemoryAtoms.agentId, agentId));
  await db.delete(agentMemoryScenarios).where(eq(agentMemoryScenarios.agentId, agentId));
  await db.delete(agentMemory).where(eq(agentMemory.agentId, agentId));

  const homeProjectId = await resolveAgentProjectId(db, agentId).catch(() => undefined);
  const stats: WipeStats = {
    atoms: atomRows.length,
    scenarios: scenarioRows.length,
    legacyNotes: legacyRows.length,
    memoryDirRemoved: homeProjectId ? await rmIfExists(agentMemoryDir(paths, homeProjectId, agentId)) : false,
    soulRemoved: await rmIfExists(legacySoulPath(paths, agentId)),
    skillsRemoved: false,
  };
  // Pre-pivot leftovers (memory/, skills/, soul.md that never migrated).
  await rmIfExists(legacyAgentDir(paths, agentId));
  if (opts.withSkills && homeProjectId) {
    stats.skillsRemoved = await rmIfExists(agentSkillsDir(paths, homeProjectId, agentId));
  }
  return stats;
}

async function rmIfExists(target: string): Promise<boolean> {
  try {
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Immediate factory reset — same end state as the boot-time reset.flag path
 * in context.ts (everything under dataDir deleted), but performed now, for
 * when the server isn't running to do it itself.
 */
export async function wipeDataDirNow(paths: HertzPaths): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(paths.dataDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    await fs.rm(path.join(paths.dataDir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}
