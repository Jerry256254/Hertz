import { spawn } from "node:child_process";
import type { ActorContext, AuditSink } from "./audit.js";
import { NullAuditSink } from "./audit.js";
import defaultPolicyJson from "./policy.default.json" with { type: "json" };

export interface ShellPolicy {
  allowedCommands: string[];
  deniedCommands: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  allowedEnv: string[];
}

export function loadDefaultPolicy(): ShellPolicy {
  return structuredClone(defaultPolicyJson) as ShellPolicy;
}

export class ShellPolicyViolationError extends Error {
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "ShellPolicyViolationError";
    this.detail = detail;
  }
}

export interface ShellExecRequest {
  command: string;
  args: string[];
  /** Must already be a PathGuard-validated, contained absolute directory. */
  cwd: string;
}

export interface ShellExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

function checkCommandAllowed(policy: ShellPolicy, command: string): void {
  if (command.includes("/") || command.includes("\\")) {
    throw new ShellPolicyViolationError(
      `Command must be a bare binary name resolved via PATH, not a path: ${command}`,
      { command },
    );
  }
  if (policy.deniedCommands.includes(command)) {
    throw new ShellPolicyViolationError(`Command explicitly denied: ${command}`, { command });
  }
  if (!policy.allowedCommands.includes(command)) {
    throw new ShellPolicyViolationError(`Command not in allowlist: ${command}`, { command });
  }
}

/** Non-throwing variant for callers that only need the verdict (e.g. routing into an agent's container). */
export function isCommandAllowed(policy: ShellPolicy, command: string): boolean {
  try {
    checkCommandAllowed(policy, command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a command with no shell interpreter in between (argv array, `shell: false`),
 * which structurally rules out shell injection/chaining rather than trying to
 * blacklist metacharacters in a string. cwd/env are always the caller-supplied,
 * already-contained values — never the full process environment.
 */
export async function execSandboxed(
  policy: ShellPolicy,
  req: ShellExecRequest,
  ctx: ActorContext,
  audit: AuditSink = new NullAuditSink(),
): Promise<ShellExecResult> {
  try {
    checkCommandAllowed(policy, req.command);
  } catch (err) {
    audit.record({
      ...ctx,
      action: "shell.exec",
      target: req.command,
      targetType: "command",
      result: "denied",
      detail: { args: req.args, reason: (err as Error).message },
    });
    throw err;
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of policy.allowedEnv) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  const start = Date.now();
  const result = await new Promise<ShellExecResult>((resolve, reject) => {
    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, policy.timeoutMs);

    const cap = (buf: Buffer, current: string): string => {
      if (current.length >= policy.maxOutputBytes) {
        truncated = true;
        return current;
      }
      const next = current + buf.toString("utf8");
      if (next.length > policy.maxOutputBytes) {
        truncated = true;
        return next.slice(0, policy.maxOutputBytes);
      }
      return next;
    };

    child.stdout.on("data", (b: Buffer) => {
      stdout = cap(b, stdout);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr = cap(b, stderr);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });

  audit.record({
    ...ctx,
    action: "shell.exec",
    target: req.command,
    targetType: "command",
    result: "allowed",
    detail: { args: req.args, exitCode: result.exitCode, durationMs: result.durationMs },
  });

  return result;
}
