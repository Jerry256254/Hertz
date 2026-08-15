import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { projectMembers } from "../db/schema.js";
import type { AuthenticatedUser } from "./session-tokens.js";

/** Admins see/act on every project; a "user"-role account only ones they've been explicitly granted via project_members. */
export async function hasProjectAccess(db: Database, user: AuthenticatedUser, projectId: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const rows = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)))
    .limit(1);
  return rows.length > 0;
}

export async function accessibleProjectIds(db: Database, user: AuthenticatedUser): Promise<Set<string> | "all"> {
  if (user.role === "admin") return "all";
  const rows = await db.select({ projectId: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, user.id));
  return new Set(rows.map((r) => r.projectId));
}
