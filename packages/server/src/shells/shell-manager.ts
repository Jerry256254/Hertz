import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ActorContext, AuditSink } from "@kuclab-hertz/sandbox";

interface LiveShell {
  proc: ChildProcessWithoutNullStreams;
  buffer: string;
  listeners: Set<(chunk: string) => void>;
}

const MAX_BUFFER = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ShellRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * A real, persistent `bash` process per employee shell — not a one-off spawn
 * per command like the sandboxed shell_exec tool. That's the point: state
 * (cwd from `cd`, exported env vars, background jobs) survives between calls,
 * the way an actual terminal session would. This is deliberately a step down
 * from shell_exec's allowlist model — a "Linux shell" the user asked for is
 * inherently unrestricted bash, not an allowlisted command runner — so every
 * write is recorded to the audit log for the same transparency the rest of
 * the product promises, even though the *contents* aren't restricted.
 *
 * Known limitation: concurrent runCommand() calls on the same shell interleave
 * output, since there's exactly one stdin/stdout pair per shell. Fine for the
 * expected usage (one agent turn issuing one command at a time); a second
 * concurrent caller should open its own shell instead.
 */
export class ShellManager {
  private readonly live = new Map<string, LiveShell>();

  constructor(private readonly audit: AuditSink) {}

  /**
   * Returns the live shell, respawning the bash process if it isn't running
   * (first use, or it previously exited) — but keeping the existing buffer
   * and listeners so the transcript survives a respawn instead of resetting.
   */
  private ensure(shellId: string, cwd: string): LiveShell {
    const existing = this.live.get(shellId);
    if (existing && existing.proc.exitCode === null && !existing.proc.killed) return existing;

    const proc = spawn("bash", [], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const live: LiveShell = { proc, buffer: existing?.buffer ?? "", listeners: existing?.listeners ?? new Set() };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      live.buffer = (live.buffer + text).slice(-MAX_BUFFER);
      for (const listener of live.listeners) listener(text);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.stdin.on("error", () => {}); // swallow EPIPE from writing after the process has already exited
    this.live.set(shellId, live);
    return live;
  }

  private subscribe(shellId: string, listener: (chunk: string) => void): () => void {
    const live = this.live.get(shellId);
    if (!live) return () => {};
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }

  /** Runs one command to completion (via a sentinel echo trick to detect the shell's own prompt returning), and returns its output + exit code. */
  async runCommand(shellId: string, cwd: string, command: string, actor: ActorContext, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ShellRunResult> {
    const live = this.ensure(shellId, cwd);
    const marker = `__HERTZ_DONE_${randomUUID()}__`;

    const result = await new Promise<ShellRunResult>((resolve) => {
      let collected = "";
      let resolved = false;
      let timer: ReturnType<typeof setTimeout>;

      const unsubscribeOutput = this.subscribe(shellId, (chunk) => {
        collected += chunk;
        const idx = collected.indexOf(marker);
        if (idx === -1) return;
        const exitMatch = /(\d+)/.exec(collected.slice(idx + marker.length));
        finish({ output: collected.slice(0, idx).trimEnd(), exitCode: exitMatch ? Number(exitMatch[1]) : null, timedOut: false });
      });

      // A command like `exit` or `kill -9 $$` ends the shell before the sentinel echo ever
      // runs — without this listener, the promise would otherwise hang for the full timeout.
      const onProcessExit = (code: number | null) => {
        finish({ output: collected.trimEnd(), exitCode: code, timedOut: false });
      };
      live.proc.once("exit", onProcessExit);

      function finish(r: ShellRunResult) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        unsubscribeOutput();
        live.proc.off("exit", onProcessExit);
        resolve(r);
      }

      timer = setTimeout(() => finish({ output: collected, exitCode: null, timedOut: true }), timeoutMs);
      live.proc.stdin.write(`${command}\necho "${marker}$?"\n`);
    });

    this.audit.record({
      ...actor,
      action: "shell.persistent.run",
      target: shellId,
      targetType: "shell",
      result: "allowed",
      detail: { command, exitCode: result.exitCode, timedOut: result.timedOut },
    });
    return result;
  }

  /** Strips the internal completion-sentinel lines runCommand() injects — they're plumbing, not something the user should see in the transcript. */
  getBuffer(shellId: string): string {
    const raw = this.live.get(shellId)?.buffer ?? "";
    return raw.replace(/__HERTZ_DONE_[0-9a-f-]+__\d*\n?/g, "");
  }

  isAlive(shellId: string): boolean {
    const live = this.live.get(shellId);
    return !!live && live.proc.exitCode === null && !live.proc.killed;
  }

  kill(shellId: string): void {
    const live = this.live.get(shellId);
    if (live) {
      live.proc.kill();
      this.live.delete(shellId);
    }
  }
}
