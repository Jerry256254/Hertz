import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

/**
 * A long-lived Playwright daemon running INSIDE the agent's container, driven
 * over line-delimited JSON on stdin/stdout of one `docker exec` process.
 * Keeping one process (and therefore one browser) alive across tool calls is
 * what makes login sessions persist: navigate → log in → later calls are still
 * authenticated, exactly like a human's browsing session.
 */
interface PendingCall {
  resolve: (value: { ok: boolean; data?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CALL_TIMEOUT_MS = 90_000;

export class BrowserSession {
  private proc?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(
    private readonly argvPrefix: () => string[],
    private readonly onExit?: () => void,
  ) {}

  isAlive(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  async start(): Promise<void> {
    if (this.isAlive()) return;
    const prefix = this.argvPrefix();
    this.proc = spawn(prefix[0]!, [...prefix.slice(1), "node", "/opt/hertz/browser.mjs"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
    });
    this.buffer = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => {});
    this.proc.once("exit", () => {
      for (const [, call] of this.pending) {
        clearTimeout(call.timer);
        call.resolve({ ok: false, error: "Browser daemon exited" });
      }
      this.pending.clear();
      this.proc = undefined;
      this.onExit?.();
    });
    // Give the daemon a moment to boot Chromium; first call will block anyway.
    await new Promise((r) => setTimeout(r, 250));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; ok?: boolean; data?: unknown; error?: string };
        if (!msg.id || !this.pending.has(msg.id)) continue;
        const call = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(call.timer);
        call.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error });
      } catch {
        /* non-JSON line — ignore */
      }
    }
  }

  async act(action: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    if (!this.isAlive()) await this.start();
    if (!this.proc) return { ok: false, error: "Browser daemon could not be started" };

    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Browser action "${action}" timed out after ${CALL_TIMEOUT_MS / 1000}s` });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        this.proc!.stdin.write(`${JSON.stringify({ id, action, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: `Browser daemon write failed: ${(err as Error).message}` });
      }
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }
}
