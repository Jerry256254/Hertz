import fs from "node:fs/promises";
import path from "node:path";
import { asc } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { newId } from "../db/client.js";
import { projectRoots, projects } from "../db/schema.js";

/**
 * Hertz is a personal assistant, not a project manager: there is exactly one
 * implicit workspace. The `projects` table survives only as a DB-level
 * container for the sandbox roots (sessions, agents and the path guard are
 * all keyed by projectId) — it never surfaces in the UI, the setup wizard,
 * or chat. No user ever picks, names, or switches a "project".
 *
 * For existing installs the oldest project wins, so nobody's files move.
 * Fresh installs get a workspace folder inside the Hertz data dir.
 */
export async function ensureDefaultProject(ctx: AppContext): Promise<string> {
  const existing = await ctx.db
    .select({ id: projects.id })
    .from(projects)
    .orderBy(asc(projects.createdAt))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const id = newId();
  const now = new Date();
  const rootPath = path.join(ctx.paths.dataDir, "workspace");
  await fs.mkdir(rootPath, { recursive: true });
  await ctx.db.insert(projects).values({ id, name: "Osobní", createdAt: now });
  await ctx.db.insert(projectRoots).values({
    id: newId(),
    projectId: id,
    rootId: "main",
    label: "Pracovní složka",
    absolutePath: rootPath,
  });
  return id;
}
