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
    /** Resolves the agent's image + mounted paths so an old container can be recreated with the desktop port. */
    private readonly resolveContext?: (agentId: string) => Promise<{ image: string | null; mountPaths: string[] }>,
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
    if (state === "unavailable") {
      throw new Error(
        "Docker isn't accessible to the Hertz service. Re-run the installer (curl -fsSL https://raw.githubusercontent.com/Jerry256254/Hertz/main/install.sh | bash) — it adds the service user to the docker group and restarts the service.",
      );
    }
    // Missing or stopped container: bring it up right here — starting the
    // desktop should never require the user to trigger a run first.
    if (state !== "running") {
      const ctxInfo = (await this.resolveContext?.(agentId)) ?? { image: null, mountPaths: [] };
      await this.computer.ensureContainer({ agentId, image: ctxInfo.image, mountPaths: ctxInfo.mountPaths });
    }

    // Old containers predate the desktop port publish — recreate once so the
    // screen can be proxied at all (bind mounts keep project + personal data).
    const ctxInfo = (await this.resolveContext?.(agentId)) ?? { image: null, mountPaths: [] };
    const hostPort = await this.ensureDesktopPort(agentId, ctxInfo.image, ctxInfo.mountPaths);

    // The image must actually contain the desktop stack.
    const hasStack = await this.execInContainer(agentId, "bash", ["-c", "command -v websockify >/dev/null && echo yes || echo no"]);
    if (hasStack.stdout.trim() !== "yes") {
      throw new Error(
        "This computer image has no desktop stack (websockify missing). Rebuild it: docker build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile . — install.sh does this automatically.",
      );
    }

    const already = await this.execInContainer(
      agentId,
      "bash",
      ["-c", "pgrep -f 'websockify.*6080' >/dev/null && echo yes || echo no"],
    );
    if (already.stdout.trim() !== "yes") {
      await this.computer.run(["docker", "exec", this.computer.containerName(agentId), "mkdir", "-p", "/opt/hertz", "/tmp/.X11-unix"]);
      await this.installScript(agentId);
      await this.computer.run(["docker", "exec", "-d", this.computer.containerName(agentId), "bash", "/opt/hertz/start-desktop.sh"]);
      // Give Xvfb + websockify a moment to bind before we report status.
      await new Promise((r) => setTimeout(r, 2_000));
    }

    const status = await this.status(agentId);
    const x11vncUp = await this.execInContainer(agentId, "bash", ["-c", "pgrep x11vnc >/dev/null && echo yes || echo no"]);
    if (!status.running || !status.hostPort || x11vncUp.stdout.trim() !== "yes") {
      const logs = await this.execInContainer(agentId, "bash", [
        "-c",
        "echo '--- xvfb:'; tail -5 /tmp/xvfb.log 2>/dev/null; echo '--- x11vnc:'; tail -5 /tmp/x11vnc.log 2>/dev/null; echo '--- websockify:'; tail -5 /tmp/websockify.log 2>/dev/null; true",
      ]);
      throw new Error(`Desktop failed to start inside the container. Logs:\n${logs.stdout.trim() || "(empty)"}`);
    }
    return status;
  }

  /**
   * Containers created before the desktop feature lack the 6080 publish —
   * detect and recreate once (bind mounts keep the agent's project and
   * personal data; in-container apt installs are lost, which we log).
   */
  async ensureDesktopPort(agentId: string, image: string | null, mountPaths: string[]): Promise<number | undefined> {
    const existing = await this.resolveHostPort(agentId);
    if (existing) return existing;
    console.warn(`[hertz] container for agent ${agentId} has no desktop port — recreating it (mounted folders are kept)`);
    await this.computer.destroyContainer(agentId);
    await this.computer.ensureContainer({ agentId, image, mountPaths });
    return this.resolveHostPort(agentId);
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
# Robust version: every process logs to a file (no SIGPIPE deaths from the
# closed docker-exec pipe), X lock files are cleaned, and each stage waits
# for the previous one to actually be ready.
set -x
export DISPLAY=:99

pkill -f 'Xvfb :99' 2>/dev/null
pkill x11vnc 2>/dev/null
pkill -f 'websockify.*6080' 2>/dev/null
pkill xfce4-session 2>/dev/null
sleep 0.5
rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock

nohup Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 40); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.25; done

if command -v startxfce4 >/dev/null 2>&1; then
  nohup dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1 &
fi

nohup x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -listen 0.0.0.0 -quiet >/tmp/x11vnc.log 2>&1 &
for i in $(seq 1 40); do
  (exec 3<>/dev/tcp/127.0.0.1/5900) 2>/dev/null && { exec 3>&- 3<&-; break; }
  sleep 0.25
done

nohup websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
sleep 0.5
echo "desktop stack up"
`;
