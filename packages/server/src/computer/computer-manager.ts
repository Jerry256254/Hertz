import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuditSink } from "@kuclab-hertz/sandbox";
import type { ComputerRuntime } from "@kuclab-hertz/tools";
import { BROWSER_DAEMON_SOURCE } from "./browser-daemon.js";
import { BrowserSession } from "./browser-session.js";

export const DEFAULT_COMPUTER_IMAGE = "kuclab-hertz-computer:latest";
const EXEC_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;
const AVAILABILITY_CACHE_MS = 60_000;

export interface ContainerSpec {
  agentId: string;
  image?: string | null;
  /** Bind-mounted at their host-absolute paths so PathGuard-resolved paths stay valid inside the container. */
  mountPaths: string[];
}

/**
 * Gives every agent its own isolated "computer" — a long-lived Docker container
 * with the project and the agent's personal directory bind-mounted at their
 * host paths, resource caps, no-new-privileges, and restart-on-boot so a bot's
 * machine comes back after a server reboot without anyone touching it.
 *
 * The host keeps deciding WHAT is allowed (PathGuard, allowlist); the container
 * only changes WHERE commands execute. That keeps one security model while
 * giving Grok-Bot-style isolation: an agent that rm -rf's its workspace takes
 * down its own container's mounts, not the server.
 */
export class ComputerManager {
  private dockerAvailable?: { value: boolean; at: number };
  private readonly browsers = new Map<string, BrowserSession>();

  constructor(private readonly audit: AuditSink) {}

  async isDockerAvailable(): Promise<boolean> {
    const cached = this.dockerAvailable;
    if (cached && Date.now() - cached.at < AVAILABILITY_CACHE_MS) return cached.value;
    const value = await new Promise<boolean>((resolve) => {
      const child = spawn("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    this.dockerAvailable = { value, at: Date.now() };
    return value;
  }

  containerName(agentId: string): string {
    return `hertz-agent-${agentId}`;
  }

  /** docker exec argv prefix for routing persistent shells into this agent's container. */
  execPrefix(agentId: string): string[] {
    return ["docker", "exec", "-i", this.containerName(agentId)];
  }

  async status(agentId: string): Promise<"missing" | "running" | "stopped" | "unavailable"> {
    if (!(await this.isDockerAvailable())) return "unavailable";
    const out = await this.run(["docker", "inspect", "-f", "{{.State.Running}}", this.containerName(agentId)]);
    if (out.exitCode !== 0) return "missing";
    return out.stdout.trim() === "true" ? "running" : "stopped";
  }

  /** Idempotent: reuses a running container, restarts a stopped one, creates otherwise. */
  async ensureContainer(spec: ContainerSpec): Promise<{ containerName: string; created: boolean }> {
    const name = this.containerName(spec.agentId);
    const state = await this.status(spec.agentId);
    if (state === "running") return { containerName: name, created: false };

    if (state === "stopped") {
      await this.run(["docker", "start", name]);
      return { containerName: name, created: false };
    }
    if (state === "unavailable") {
      throw new Error("Docker isn't available on this machine — switch the agent to the 'local' backend or install Docker");
    }

    const image = spec.image?.trim() || DEFAULT_COMPUTER_IMAGE;
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "kuclab-hertz.managed=true",
      "--restart",
      "unless-stopped",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--pids-limit",
      "512",
      "--security-opt",
      "no-new-privileges",
    ];
    for (const p of spec.mountPaths) args.push("-v", `${p}:${p}`);
    args.push(image, "sleep", "infinity");

    const result = await this.run(args);
    if (result.exitCode !== 0) {
      // A stale container row with a conflicting name is the common failure — remove and retry once.
      await this.run(["docker", "rm", "-f", name]);
      const retry = await this.run(args);
      if (retry.exitCode !== 0) {
        throw new Error(`Failed to start computer container: ${retry.stderr.trim() || retry.stdout.trim()}`);
      }
    }
    await this.installBrowserDaemon(spec.agentId);
    return { containerName: name, created: true };
  }

  /** Copies the Playwright daemon into the container (/opt/hertz/browser.mjs). Idempotent per container start. */
  private async installBrowserDaemon(agentId: string): Promise<void> {
    try {
      const tmp = path.join(os.tmpdir(), `hertz-browser-${agentId}.mjs`);
      await fs.writeFile(tmp, BROWSER_DAEMON_SOURCE, "utf8");
      await this.run(["docker", "cp", tmp, `${this.containerName(agentId)}:/opt/hertz/browser.mjs`]);
      await fs.rm(tmp, { force: true });
    } catch {
      // Browser automation is optional — shell/fs work fine without it.
    }
  }

  /** The agent's persistent browser daemon (started lazily on first use). */
  browserSession(agentId: string): BrowserSession {
    let session = this.browsers.get(agentId);
    if (!session) {
      session = new BrowserSession(
        () => ["docker", "exec", "-i", "-w", "/workspace", this.containerName(agentId)],
        () => this.browsers.delete(agentId),
      );
      this.browsers.set(agentId, session);
    }
    return session;
  }

  async destroyContainer(agentId: string): Promise<void> {
    this.browsers.get(agentId)?.stop();
    this.browsers.delete(agentId);
    await this.run(["docker", "rm", "-f", this.containerName(agentId)]);
  }

  runtime(agentId: string): ComputerRuntime {
    return {
      exec: (input) => this.execIn({ ...input, agentId }),
    };
  }

  /** Low-level exec used by ComputerRuntime; command must be allowlisted by the caller. */
  async execIn(input: { agentId: string; command: string; args: string[]; cwd: string; timeoutMs?: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
  }> {
    const timeoutMs = input.timeoutMs ?? EXEC_TIMEOUT_MS;
    const argv = ["exec", "-w", input.cwd, this.containerName(input.agentId), input.command, ...input.args];
    return new Promise((resolve, reject) => {
      const child = spawn("docker", argv, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const cap = (buf: Buffer, current: string): string => {
        if (current.length >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return current;
        }
        const next = current + buf.toString("utf8");
        if (next.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          return next.slice(0, MAX_OUTPUT_BYTES);
        }
        return next;
      };

      child.stdout.on("data", (b: Buffer) => {
        stdout = cap(b, stdout);
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr = cap(b, stderr);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, truncated, timedOut });
      });
    });
  }

  private run(argv: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    });
  }

  auditRecord(actor: Parameters<AuditSink["record"]>[0]): void {
    this.audit.record(actor);
  }
}
