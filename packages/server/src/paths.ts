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
 * An employee's own on-disk space — personal notes, materials, exports from
 * MCP tools — in addition to (not instead of) the project root they share with
 * the rest of the team. Registered as sandbox root "self" alongside "main" so
 * the existing fs tools can address it, keyed by project since the same
 * employee's folder is per-project (they can be attached to several).
 */
export function employeeDir(paths: HertzPaths, projectId: string, agentId: string): string {
  return path.join(paths.projectsDir, projectId, "employees", agentId);
}

export function employeeSubdirs(paths: HertzPaths, projectId: string, agentId: string): { notes: string; materials: string; data: string } {
  const base = employeeDir(paths, projectId, agentId);
  return { notes: path.join(base, "notes"), materials: path.join(base, "materials"), data: path.join(base, "data") };
}

/**
 * An agent's personal skills library — follows the agent across every project
 * (unlike employeeDir, which is per-project). Each skill is a folder with a
 * SKILL.md (instructions the agent wrote for itself); optional scripts sit
 * next to it. Injected into prompts as an index; full text via read_skill.
 */
export function agentSkillsDir(paths: HertzPaths, agentId: string): string {
  return path.join(paths.dataDir, "agents", agentId, "skills");
}

/** Idempotent — safe to call at hire time and again on every session start ("first access if missing"). */
export async function ensureEmployeeDirs(paths: HertzPaths, projectId: string, agentId: string): Promise<void> {
  const dirs = employeeSubdirs(paths, projectId, agentId);
  await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));
}
