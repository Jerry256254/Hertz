import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

export interface HertzPaths {
  dataDir: string;
  configPath: string;
  masterKeyPath: string;
  dbPath: string;
  logsDir: string;
  serverLogPath: string;
  auditLogPath: string;
  projectsDir: string;
  sessionsDir: string;
}

export function resolveHertzPaths(dataDir = path.join(os.homedir(), ".kuclab-hertz")): HertzPaths {
  return {
    dataDir,
    configPath: path.join(dataDir, "config.json"),
    masterKeyPath: path.join(dataDir, "master.key"),
    dbPath: path.join(dataDir, "hertz.db"),
    logsDir: path.join(dataDir, "logs"),
    serverLogPath: path.join(dataDir, "logs", "server.log"),
    auditLogPath: path.join(dataDir, "logs", "audit.log"),
    projectsDir: path.join(dataDir, "projects"),
    sessionsDir: path.join(dataDir, "sessions"),
  };
}

export function sessionBlobsDir(paths: HertzPaths, sessionId: string): string {
  return path.join(paths.sessionsDir, sessionId, "blobs");
}

export function projectSandboxPolicyPath(paths: HertzPaths, projectId: string): string {
  return path.join(paths.projectsDir, projectId, "sandbox-policy.json");
}

/**
 * An employee's own on-disk space — his home on his computer. It carries his
 * working files (notes, materials, data) AND his mind (memory/, skills/):
 * persona.md, scenarios, session canvases and skill recipes live here as real
 * files he can open. Registered as sandbox root "self" alongside "main" so
 * the fs tools can address it, and bind-mounted into his container at the
 * same path — so everything here is literally inside his virtual machine.
 * Keyed by project; memory/skills always use the agent's OWN project
 * (agents.projectId) so one agent has one home across every chat.
 *
 * The memory/skill/note tools touch this home DIRECTLY with node:fs (not via
 * PathGuard) — inherently available, bypassing host-access approval BY
 * DESIGN, because the home is inside the VM. Paths are built from trusted ids
 * plus basename'd names and assertInside() containment (see skill-tools.ts).
 */
export function employeeDir(paths: HertzPaths, projectId: string, agentId: string): string {
  return path.join(paths.projectsDir, projectId, "employees", agentId);
}

/**
 * Guard for the agent-home tools (memory/skills/notes): `target` must stay
 * inside `home`. The home bypasses host-access approval BY DESIGN — it rides
 * into the agent's VM via bind-mount (see run-jobs prepareComputer), so it is
 * the agent's own world, not the host. Returns `target` unchanged when inside.
 */
export function assertInside(home: string, target: string, what = "path"): string {
  const rel = path.relative(home, target);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`${what} escapes the agent home: ${target}`);
  }
  return target;
}

export function employeeSubdirs(paths: HertzPaths, projectId: string, agentId: string): {
  notes: string;
  materials: string;
  data: string;
  memory: string;
  skills: string;
} {
  const base = employeeDir(paths, projectId, agentId);
  return {
    notes: path.join(base, "notes"),
    materials: path.join(base, "materials"),
    data: path.join(base, "data"),
    memory: path.join(base, "memory"),
    skills: path.join(base, "skills"),
  };
}

/**
 * An agent's personal skills library — follows the agent across every project
 * and chat. Each skill is a folder with a SKILL.md (instructions the agent
 * wrote for itself); optional scripts sit next to it. Injected into prompts
 * as an index; full text via read_skill.
 */
export function agentSkillsDir(paths: HertzPaths, projectId: string, agentId: string): string {
  return path.join(employeeDir(paths, projectId, agentId), "skills");
}

/** Idempotent — safe to call at hire time and again on every session start ("first access if missing"). */
export async function ensureEmployeeDirs(paths: HertzPaths, projectId: string, agentId: string): Promise<void> {
  const dirs = employeeSubdirs(paths, projectId, agentId);
  await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));
  // Pre-pivot installs keep their mind under dataDir/agents/<id>/ — adopt it
  // into the home once, then the old shell is just an empty leftover.
  await migrateAgentHome(paths, projectId, agentId).catch(() => {});
}

/**
 * An agent's own layered long-term + short-term memory on disk (white-box),
 * inside his home (see employeeDir): `memory/` carries the human-readable top
 * layers while the bottom layers (atoms, raw conversations) live in the
 * database — `persona.md` (L3) → `scenarios/*.md` (L2) → DB atoms (L1) →
 * DB messages (L0), plus per-session short-term canvases under
 * `sessions/<sessionId>/`.
 */
export function agentMemoryDir(paths: HertzPaths, projectId: string, agentId: string): string {
  return path.join(employeeDir(paths, projectId, agentId), "memory");
}

/** L3 user/agent profile — the top of the memory pyramid, first-person, present tense. */
export function agentPersonaPath(paths: HertzPaths, projectId: string, agentId: string): string {
  return path.join(agentMemoryDir(paths, projectId, agentId), "persona.md");
}

/** L2 scenario blocks, one Markdown file per scenario (slug.md). */
export function agentScenariosDir(paths: HertzPaths, projectId: string, agentId: string): string {
  return path.join(agentMemoryDir(paths, projectId, agentId), "scenarios");
}

/** Short-term symbolic memory of one session: canvas.mmd + steps.jsonl + refs/*.md. */
export function agentSessionMemoryDir(paths: HertzPaths, projectId: string, agentId: string, sessionId: string): string {
  return path.join(agentMemoryDir(paths, projectId, agentId), "sessions", sessionId);
}

/** Pipeline watermarks (per-session extraction cursors, persona refresh counters). */
export function agentMemoryStatePath(paths: HertzPaths, projectId: string, agentId: string): string {
  return path.join(agentMemoryDir(paths, projectId, agentId), "state.json");
}

/** Pre-pivot home shell: agents/<agentId>/{memory,skills,soul.md} — adopted into the employee home by migrateAgentHome. */
export function legacyAgentDir(paths: HertzPaths, agentId: string): string {
  return path.join(paths.dataDir, "agents", agentId);
}

/** Pre-layered-memory identity file — migrated into persona.md on first pipeline run. */
export function legacySoulPath(paths: HertzPaths, agentId: string): string {
  return path.join(legacyAgentDir(paths, agentId), "soul.md");
}

/**
 * One-time adoption of a pre-pivot mind (dataDir/agents/<id>/) into the
 * agent's home. Moves whole trees (memory/, skills/) plus soul.md; never
 * overwrites — when the home already has the file, the source is left alone.
 * Idempotent and best-effort: safe to call on every session start.
 */
export async function migrateAgentHome(paths: HertzPaths, projectId: string, agentId: string): Promise<void> {
  const legacy = legacyAgentDir(paths, agentId);
  const homeMemory = agentMemoryDir(paths, projectId, agentId);
  const moves: Array<[from: string, to: string]> = [
    [path.join(legacy, "memory"), homeMemory],
    [path.join(legacy, "skills"), agentSkillsDir(paths, projectId, agentId)],
    [path.join(legacy, "soul.md"), path.join(homeMemory, "soul.md")],
  ];
  for (const [from, to] of moves) {
    try {
      await fs.access(from);
    } catch {
      continue; // nothing to move
    }
    try {
      await fs.access(to);
      continue; // home already has it — never overwrite
    } catch {
      /* target free */
    }
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
    } catch {
      /* best effort — the fallback readers still check the legacy paths */
    }
  }
  // Drop the old shell when it's empty; leftovers mean divergence, keep them.
  try {
    await fs.rmdir(legacy);
  } catch {
    /* not empty or already gone */
  }
}
