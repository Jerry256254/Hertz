import { and, eq, isNull, or } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mounts } from "../db/schema.js";

export type MountRow = typeof mounts.$inferSelect;

/** Agent-visible slug: 2–32 chars, lowercase alphanumerics, dash, underscore. */
export const MOUNT_NAME_REGEX = /^[a-z0-9][a-z0-9-_]{1,31}$/;

/**
 * Root ids that already mean something to PathGuard / the runtime and must
 * never be shadowed by a user mount: 'main' is the project root (V1 source of
 * truth stays in project_roots), 'self' the agent's personal folder, 'host'
 * and 'tmp' reserved for future use.
 */
export const RESERVED_MOUNT_NAMES = new Set(["main", "self", "host", "tmp"]);

/** Returns an error message for an invalid mount name, or null when valid. */
export function validateMountName(name: string): string | null {
  if (!MOUNT_NAME_REGEX.test(name)) {
    return "Name must be 2–32 chars: lowercase letters, digits, dash, underscore, starting with a letter or digit";
  }
  if (RESERVED_MOUNT_NAMES.has(name)) {
    return `Name '${name}' is reserved (built-in folder) — pick another`;
  }
  return null;
}

/**
 * THE one helper for mount lookup — every runtime assembly point (run-jobs,
 * context resolveContext, agents computer endpoints) goes through here so the
 * mount set cannot drift between them. Returns project-wide mounts
 * (agentId null) plus mounts scoped to this agent, ordered by name.
 */
export async function mountsFor(db: Database, projectId: string, agentId: string): Promise<MountRow[]> {
  return db
    .select()
    .from(mounts)
    .where(and(eq(mounts.projectId, projectId), or(isNull(mounts.agentId), eq(mounts.agentId, agentId))))
    .orderBy(mounts.name);
}

/** Mount rows as extra PathGuard roots: { [mount.name]: hostPath }. */
export function mountRoots(rows: MountRow[]): Record<string, string> {
  const roots: Record<string, string> = {};
  for (const m of rows) roots[m.name] = m.hostPath;
  return roots;
}

/** Container bind-mount paths contributed by these rows. */
export function mountPaths(rows: MountRow[]): string[] {
  return rows.map((m) => m.hostPath);
}

/**
 * Renders the "Your folders" system-prompt block: the two built-in folders
 * plus every mount (name + user purpose + root id to pass to fs tools).
 */
export function renderFoldersBlock(rows: Pick<MountRow, "name" | "purpose">[]): string {
  const lines = [
    "## Your folders",
    "Folders mounted into your computer. Pass the root id to file tools (read_file, write_file, edit_file, glob, grep, shell_exec cwd) to work there:",
    "- main — your workspace folder (root 'main', used when you omit root)",
    "- self — your own personal folder for notes, materials and data (root 'self')",
  ];
  for (const m of rows) {
    lines.push(`- ${m.name} — ${m.purpose?.trim() || "(no description)"} (root '${m.name}')`);
  }
  return lines.join("\n");
}
