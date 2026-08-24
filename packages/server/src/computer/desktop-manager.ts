import type { ComputerManager } from "./computer-manager.js";

export interface DesktopStatus {
  running: boolean;
  /** Host-side port the noVNC websocket is mapped to (localhost only). */
  hostPort?: number;
  containerName: string;
}

/**
 * The agent's visible desktop inside its container:
 *   Xvfb (:99) → x11vnc (5900) ← websockify/noVNC (6080)
 *
 * Each daemon is started as the MAIN process of its own `docker exec -d`
 * session — Docker never kills the main process of an exec session, so the
 * daemons are guaranteed to survive regardless of any other session exiting.
 */
export class DesktopManager {
  constructor(
    private readonly computer: ComputerManager,
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

  async start(agentId: string): Promise<DesktopStatus> {
    const state = await this.computer.status(agentId);
    if (state === "unavailable") {
      throw new Error(
        "Docker isn't accessible to the Hertz service. Re-run the installer — it adds the service user to the docker group.",
      );
    }
    if (state !== "running") {
      const ctxInfo = (await this.resolveContext?.(agentId)) ?? { image: null, mountPaths: [] };
      await this.computer.ensureContainer({ agentId, image: ctxInfo.image, mountPaths: ctxInfo.mountPaths });
    }

    // The image must contain the desktop stack.
    const hasStack = await this.execInContainer(agentId, "bash", ["-c", "command -v websockify >/dev/null && command -v x11vnc >/dev/null && echo yes || echo no"]);
    if (hasStack.stdout.trim() !== "yes") {
      throw new Error("Computer image missing desktop stack (websockify/x11vnc). Rebuild: docker build -t kuclab-hertz-computer:latest -f docker/computer.Dockerfile .");
    }

    // Check if the FULL stack is already up (all three processes).
    const stackCheck = await this.execInContainer(agentId, "bash", [
      "-c",
      "pgrep -f 'Xvfb :99' >/dev/null && pgrep x11vnc >/dev/null && pgrep -f 'websockify.*6080' >/dev/null && echo yes || echo no",
    ]);
    if (stackCheck.stdout.trim() === "yes") {
      const status = await this.status(agentId);
      if (status.running && status.hostPort) return status;
    }

    // Kill any partial stack and start fresh — each daemon as the MAIN process
    // of its own exec session (Docker never kills exec session main processes).
    const cn = this.computer.containerName(agentId);
    await this.computer.run(["docker", "exec", cn, "bash", "-c",
      "pkill -f 'Xvfb :99' 2>/dev/null; pkill x11vnc 2>/dev/null; pkill -f 'websockify.*6080' 2>/dev/null; pkill xfce4-session 2>/dev/null; pkill xfwm4 2>/dev/null; rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock; exit 0",
    ]);
    await new Promise((r) => setTimeout(r, 500));

    // 1. Xvfb
    await this.computer.run(["docker", "exec", "-d", cn, "bash", "-c",
      "Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1"]);
    // Wait for X socket
    await this.computer.run(["docker", "exec", cn, "bash", "-c",
      "for i in $(seq 1 60); do [ -S /tmp/.X11-unix/X99 ] && exit 0; sleep 0.25; done; exit 1",
    ]).catch(() => {});

    // 2. Desktop environment (xfce + wm fallback)
    await this.computer.run(["docker", "exec", "-d", cn, "bash", "-c",
      "xsetroot -solid '#2b2f36' 2>/dev/null; if command -v startxfce4 >/dev/null; then dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1; fi; command -v xfwm4 >/dev/null && (pgrep xfwm4 >/dev/null || xfwm4 >/tmp/xfwm4.log 2>&1); nohup xfce4-terminal --geometry=110x32 >/tmp/terminal.log 2>&1 & sleep 3; exit 0",
    ]);
    await new Promise((r) => setTimeout(r, 3_000));

    // 3. x11vnc
    await this.computer.run(["docker", "exec", "-d", cn, "bash", "-c",
      "x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -listen 0.0.0.0 -quiet >/tmp/x11vnc.log 2>&1",
    ]);
    // Wait for VNC port
    await this.computer.run(["docker", "exec", cn, "bash", "-c",
      "for i in $(seq 1 60); do (exec 3<>/dev/tcp/127.0.0.1/5900) 2>/dev/null && exit 0; sleep 0.25; done; exit 1",
    ]).catch(() => {});

    // 4. websockify
    await this.computer.run(["docker", "exec", "-d", cn, "bash", "-c",
      "websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1",
    ]);
    await new Promise((r) => setTimeout(r, 1_000));

    // Verify all three processes are alive
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      const probe = await this.execInContainer(agentId, "bash", ["-c",
        "pgrep -f 'Xvfb :99' >/dev/null && pgrep x11vnc >/dev/null && pgrep -f 'websockify.*6080' >/dev/null && echo yes || echo no",
      ]);
      if (probe.stdout.trim() === "yes") { ready = true; break; }
      await new Promise((r) => setTimeout(r, 600));
    }

    const status = await this.status(agentId);
    if (!ready || !status.running || !status.hostPort) {
      const logs = await this.execInContainer(agentId, "bash", ["-c",
        "echo '--- xvfb:'; tail -8 /tmp/xvfb.log 2>/dev/null; echo '--- x11vnc:'; tail -8 /tmp/x11vnc.log 2>/dev/null; echo '--- websockify:'; tail -8 /tmp/websockify.log 2>/dev/null; echo '--- xfce:'; tail -8 /tmp/xfce.log 2>/dev/null; echo '--- procs:'; ps aux | grep -E 'Xvfb|x11vnc|websockify' | grep -v grep; true",
      ]);
      throw new Error(`Desktop failed to start. Logs:\n${logs.stdout.trim() || "(empty)"}`);
    }
    return status;
  }

  async ensureDesktopPort(agentId: string, image: string | null, mountPaths: string[]): Promise<number | undefined> {
    const existing = await this.resolveHostPort(agentId);
    if (existing) return existing;
    console.warn(`[hertz] container for agent ${agentId} has no desktop port — recreating (bind mounts kept)`);
    await this.computer.destroyContainer(agentId);
    await this.computer.ensureContainer({ agentId, image, mountPaths });
    return this.resolveHostPort(agentId);
  }

  async stop(agentId: string): Promise<void> {
    await this.execInContainer(agentId, "bash", ["-c",
      "pkill -f 'Xvfb :99'; pkill x11vnc; pkill -f 'websockify.*6080'; pkill xfce4-session; exit 0",
    ]);
  }

  async resolveHostPort(agentId: string): Promise<number | undefined> {
    const out = await this.computer.run(["docker", "port", this.computer.containerName(agentId), "6080"]);
    if (out.exitCode !== 0) return undefined;
    const match = /:(\d+)\s*$/m.exec(out.stdout.trim());
    if (!match) return undefined;
    const port = Number(match[1]);
    return Number.isFinite(port) ? port : undefined;
  }

  async execInContainer(agentId: string, command: string, args: string[]) {
    return this.computer.execIn({ agentId, command, args, cwd: "/" });
  }
}
