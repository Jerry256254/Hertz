import os from "node:os";
import path from "node:path";

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
