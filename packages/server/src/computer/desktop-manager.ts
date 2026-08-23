import { spawn } from "node:child_process";
import type { AuditSink } from "@kuclab-hertz/sandbox";
import type { ComputerManager } from "./computer-manager.js";

export interface DesktopStatus {
  running: boolean;
  /** Host-side port the noVNC websocket is mapped to (localhost only). */
  hostPort?: number;
  containerName: string;
}

/**
 * The agent's visible desktop inside its container:
 *
 *   Xvfb (:99)  →  x11vnc (5900)  ←  websockify/noVNC (6080)
 *
 * Playwright's Chromium runs headed on :99, so whatever the bot does in its
 * browser — and any login page it opens — is exactly what the CEO sees on the
 * streamed screen. The noVNC port is published to 127.0.0.1 only; the server
 * proxies authenticated WebSocket connections to it (see routes/screen.ts),
 * so access control stays in Hertz, not in Docker port mappings.
 */
export class DesktopManager {
  private readonly portCache = new Map<string, number>();

  constructor(
    private readonly computer: ComputerManager,
    private readonly audit: AuditSink,
  ) {}

  async status(agentId: string): Promise<DesktopStatus> {
    const containerName = this.computer.containerName(agentId);
    const state = await this.computer.status(agentId);
    if (state !== "running") return { running: false, containerName };

    const probe = await this.execInContainer(agentId, "bash", ["-c", "pgrep -f 'websockify.*6080' >/dev/null && echo yes || echo no"]);
    const running = probe.stdout.trim() === "yes";
    return { running, containerName, ...(running ? { hostPort: await this.resolveHostPort(agentId) } : {}) };
  }

  /** Idempotent — starts Xvfb/x11vnc/websockify (+ an Xfce session) if not already up. */
  async start(agentId: string): Promise<DesktopStatus> {
    const state = await this.computer.status(agentId);
    if (state !== "running") {
      throw new Error(
        "The agent's container isn't running yet — it starts automatically on the agent's next run. Trigger any message first, then retry.",
      );
    }
    const containerName = this.computer.containerName(agentId);

    const already = await this.execInContainer(
      agentId,
      "bash",
      ["-c", "pgrep -f 'websockify.*6080' >/dev/null && echo yes || echo no"],
    );
    if (already.stdout.trim() !== "yes") {
      // Install the desktop bootstrap script, then launch the stack detached.
      await this.computer.run([
        "docker", "exec", containerName, "mkdir", "-p", "/opt/hertz", "/tmp/.X11-unix",
      ]);
      await this.installScript(agentId);
      await this.computer.run(["docker", "exec", "-d", containerName, "bash", "/opt/hertz/start-desktop.sh"]);
      // Give websockify a moment to bind before we resolve the mapped port.
      await new Promise((r) => setTimeout(r, 1_500));
    }

    const status = await this.status(agentId);
    if (!status.running) {
      throw new Error("Desktop failed to start inside the container — check `docker logs` / journalctl for details");
    }
    return status;
  }

  async stop(agentId: string): Promise<void> {
    await this.execInContainer(agentId, "bash", [
      "-c",
      "pkill -f 'websockify.*6080'; pkill x11vnc; pkill -f 'Xvfb :99'; pkill xfce4-session; true",
    ]);
    this.portCache.delete(agentId);
  }

  /**
   * Resolves (and caches) the random localhost port Docker mapped to the
   * container's 6080. Requires the container to have been created by
   * ComputerManager with the desktop publish flag.
   */
  async resolveHostPort(agentId: string): Promise<number | undefined> {
    const cached = this.portCache.get(agentId);
    if (cached) return cached;

    const out = await this.computer.run(["docker", "port", this.computer.containerName(agentId), "6080"]);
    if (out.exitCode !== 0) return undefined;
    // "127.0.0.1:54321" or "[::]:54321"-style output
    const match = /:(\d+)\s*$/m.exec(out.stdout.trim());
    if (!match) return undefined;
    const port = Number(match[1]);
    if (Number.isFinite(port)) this.portCache.set(agentId, port);
    return port;
  }

  /** The bot's browser daemon must run ON the visible display. */
  displayEnvArgs(): string[] {
    return ["-e", "DISPLAY=:99"];
  }

  private async installScript(agentId: string): Promise<void> {
    await this.computer.writeFileInto(agentId, "/opt/hertz/start-desktop.sh", START_DESKTOP_SCRIPT);
  }

  private execInContainer(agentId: string, command: string, args: string[]) {
    return this.computer.execIn({ agentId, command, args, cwd: "/" });
  }

  auditRecord(actor: Parameters<AuditSink["record"]>[0]): void {
    this.audit.record(actor);
  }
}

export const START_DESKTOP_SCRIPT = String.raw`#!/usr/bin/env bash
# Bootstraps the visible desktop inside an agent container.
set -x
export DISPLAY=:99
pkill -f 'Xvfb :99' 2>/dev/null; pkill x11vnc 2>/dev/null; pkill -f 'websockify.*6080' 2>/dev/null
sleep 0.5

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
sleep 1

# A window manager makes Chromium windows behave (move/resize/focus).
which startxfce4 >/dev/null 2>&1 && (dbus-launch --exit-with-session startxfce4 >/dev/null 2>&1 &)

x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -quiet &
sleep 0.5

websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
`;
