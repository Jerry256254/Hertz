import { z } from "zod";
import os from "node:os";
import fs from "node:fs/promises";
import type { ToolContext, ToolResult } from "@kuclab-hertz/tools";
import type { AgentToolDef } from "./tool-def.js";
import type { Database } from "../db/client.js";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import { signScreenToken } from "../secrets/screen-token.js";
import { consumeVaultGrantForFill } from "./vault-tools.js";
import { takeoverMessageText } from "../routes/screen.js";
import type { DesktopManager } from "../computer/desktop-manager.js";

/**
 * Desktop control for docker-backend agents — the bot's own visible machine:
 * mouse/keyboard via xdotool on the Xfce display, and full-screen screenshots
 * that VISION models read directly (non-vision models get a clear notice to
 * fall back to browser_snapshot instead of pretending they can see).
 */
export function createDesktopTools(db: Database, masterKey: Buffer, desktop: DesktopManager): AgentToolDef[] {
  function requireComputer(ctx: ToolContext): NonNullable<ToolContext["computer"]> | ToolResult {
    if (!ctx.computer) {
      return {
        summary:
          "Desktop tools need your own computer: ask the user to switch your computer backend to 'docker' (image kuclab-hertz-computer).",
        isError: true,
      };
    }
    return ctx.computer;
  }

  async function xdotool(ctx: ToolContext, args: string): Promise<ToolResult> {
    const computer = requireComputer(ctx);
    if ("summary" in computer) return computer;
    const res = await computer.exec({
      command: "bash",
      args: ["-lc", `export DISPLAY=:99; xdotool ${args}`],
      cwd: "/",
    });
    const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    return { summary: out || "done", isError: res.exitCode !== 0 };
  }

  const click: AgentToolDef = {
    name: "desktop_click",
    description:
      "Click on YOUR desktop at pixel coordinates you read from desktop_read_screen. button: left (default) / right / middle; double for double-click.",
    inputSchema: z.object({
      x: z.number().int().min(0).max(4000),
      y: z.number().int().min(0).max(4000),
      button: z.enum(["left", "right", "middle"]).optional().default("left"),
      double: z.boolean().optional().default(false),
    }),
    async execute(rawInput, ctx) {
      const input = z
        .object({ x: z.number(), y: z.number(), button: z.enum(["left", "right", "middle"]).default("left"), double: z.boolean().default(false) })
        .parse(rawInput);
      const btn = { left: 1, middle: 2, right: 3 }[input.button];
      const seq = input.double
        ? `mousemove --sync ${input.x} ${input.y} click --repeat 2 --delay 120 ${btn}`
        : `mousemove --sync ${input.x} ${input.y} click ${btn}`;
      return xdotool(ctx, seq);
    },
  };

  const typeText: AgentToolDef = {
    name: "desktop_type",
    description:
      "Type text into the currently focused window on YOUR desktop (click the field first with desktop_click). To type a VAULT-APPROVED password without ever seeing it, pass vaultFill:true instead of text (needs a prior approved vault_use — the grant is single-use and expires after 5 minutes); the server substitutes the secret at execution time and it never appears in logs, history, or tool results.",
    inputSchema: z
      .object({
        text: z.string().min(1).max(5_000).optional(),
        vaultFill: z
          .boolean()
          .optional()
          .describe("Type the approved vault secret instead of text — single-use grant from vault_use"),
      })
      .refine((d) => (d.vaultFill ? d.text === undefined : typeof d.text === "string"), {
        message: "Pass either text or vaultFill:true, not both",
      }),
    async execute(rawInput, ctx) {
      const input = z.object({ text: z.string().optional(), vaultFill: z.boolean().optional() }).parse(rawInput);
      if (input.vaultFill) {
        if (input.text !== undefined) {
          return { summary: "Pass either text or vaultFill:true, not both.", isError: true };
        }
        const computer = requireComputer(ctx);
        if ("summary" in computer) return computer;
        const filled = consumeVaultGrantForFill(ctx.actor.sessionId);
        if ("error" in filled) return { summary: filled.error, isError: true };
        // Substitute server-side; never let the secret near a summary, log, or audit row.
        const res = await computer.exec({
          command: "bash",
          args: ["-lc", `export DISPLAY=:99; xdotool type --delay 25 -- ${shellQuote(filled.secret)}`],
          cwd: "/",
        });
        if (res.exitCode !== 0) {
          return { summary: "desktop_type (vault) failed.", isError: true };
        }
        await ctx.audit.record({
          actorId: ctx.actor.actorId,
          actorType: "agent",
          sessionId: ctx.actor.sessionId ?? undefined,
          projectId: ctx.actor.projectId ?? undefined,
          action: "vault.fill",
          targetType: "vault_credential",
          result: "allowed",
          detail: { tool: "desktop_type", label: filled.label },
        });
        return { summary: `Údaj z trezoru „${filled.label}" napsán (hodnota skrytá).` };
      }
      if (typeof input.text !== "string" || !input.text) {
        return { summary: "Pass either text or vaultFill:true.", isError: true };
      }
      return xdotool(ctx, `type --delay 25 -- ${shellQuote(input.text)}`);
    },
  };

  const key: AgentToolDef = {
    name: "desktop_key",
    description: "Press a key or combo on YOUR desktop: 'Return', 'Escape', 'Tab', 'ctrl+l', 'ctrl+shift+t', …",
    inputSchema: z.object({ key: z.string().min(1).max(40) }),
    async execute(rawInput, ctx) {
      const input = z.object({ key: z.string() }).parse(rawInput);
      return xdotool(ctx, `key ${shellQuote(input.key)}`);
    },
  };

  const scroll: AgentToolDef = {
    name: "desktop_scroll",
    description: "Scroll on YOUR desktop at the current mouse position: direction 'up' | 'down', amount in wheel clicks.",
    inputSchema: z.object({
      direction: z.enum(["up", "down"]).optional().default("down"),
      amount: z.number().int().min(1).max(20).optional().default(3),
    }),
    async execute(rawInput, ctx) {
      const input = z.object({ direction: z.enum(["up", "down"]), amount: z.number() }).parse(rawInput);
      const button = input.direction === "down" ? 5 : 4;
      const seq = `click --repeat ${input.amount} --delay 90 ${button}`;
      return xdotool(ctx, seq);
    },
  };

  const openApp: AgentToolDef = {
    name: "desktop_open_app",
    description:
      "Launch a GUI application on YOUR desktop in the background ('google-chrome https://example.com' or 'chromium https://example.com', or any installer like 'apt install -y gimp'). Returns immediately. Terminal/file-manager apps (xterm, thunar) are for the USER's takeover view, not for agent work — use shell_exec / read_file instead; never launch a terminal or editor as an agent strategy.",
    inputSchema: z.object({ command: z.string().min(1).max(300) }),
    async execute(rawInput, ctx) {
      const input = z.object({ command: z.string() }).parse(rawInput);
      const computer = requireComputer(ctx);
      if ("summary" in computer) return computer;
      const res = await computer.exec({
        command: "bash",
        args: ["-lc", `export DISPLAY=:99; nohup ${input.command} >/tmp/app.log 2>&1 & sleep 0.3; echo launched`],
        cwd: "/",
      });
      return { summary: res.stdout.trim() || "launched", isError: res.exitCode !== 0 };
    },
  };

  const readScreen: AgentToolDef = {
    name: "desktop_read_screen",
    description:
      "Capture YOUR desktop as an image and READ it visually — what windows are open, where buttons are, what a page shows (including a login waiting for the user). Vision models receive the real image; without vision this says so — use browser_snapshot for text-only pages instead.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const computer = requireComputer(ctx);
      if ("summary" in computer) return computer;

      const res = await computer.exec({
        command: "bash",
        args: ["-lc", "export DISPLAY=:99; scrot -z -o /tmp/.hertz-screen.png && base64 -w0 /tmp/.hertz-screen.png"],
        cwd: "/",
      });
      if (res.exitCode !== 0 || !res.stdout.trim()) {
        return { summary: `Screenshot failed: ${res.stderr.trim() || "no data"} — is the desktop running?`, isError: true };
      }

      const attachment = { mimeType: "image/png", data: res.stdout.trim() };

      // Keep a copy in the agent's personal folder so the user can open it too.
      let savedNote = "in-memory only";
      try {
        const dir = ctx.pathGuard.resolve(ctx.actor, "self", "materials");
        await fs.writeFile(`${dir}/screen-${Date.now()}.png`, Buffer.from(attachment.data, "base64"));
        savedNote = "copy saved to self/materials";
      } catch {
        /* best-effort */
      }

      return {
        summary: `Desktop captured (${savedNote}). Read it from the attached image.`,
        attachments: [attachment],
      };
    },
  };

  const requestTakeover: AgentToolDef = {
    name: "request_takeover",
    description:
      "Ask the USER to take over your screen for a step you must NOT do yourself — entering passwords, payment details, 2FA codes, captchas. Navigate to the login page first (browser_navigate), then call this with a concrete reason. The user gets live links (LAN + automatic public tunnel when available), logs in while none of the secret ever reaches you, then hands back and you continue already signed-in. Never ask for credentials in chat and never invent workarounds — this is the correct path.",
    inputSchema: z.object({
      reason: z.string().min(1).describe("What exactly the user should do on your screen, e.g. 'log into LinkedIn so I can continue outreach'"),
    }),
    async execute(rawInput, ctx) {
      const input = z.object({ reason: z.string() }).parse(rawInput);

      // Make sure the visible desktop (and its noVNC port) is up before handing out links.
      let lanUrl: string | null = null;
      try {
        const started = await desktop.start(ctx.actor.actorId);
        if (started.hostPort) {
          const port = Number(process.env.HERTZ_PORT ?? 4173);
          const lanIp = Object.values(os.networkInterfaces())
            .flat()
            .find((n) => n?.family === "IPv4" && !n.internal)?.address;
          if (lanIp) {
            const token = signScreenToken(masterKey, { agentId: ctx.actor.actorId, exp: Date.now() + 6 * 3600_000 });
            lanUrl = `http://${lanIp}:${port}/screen/${ctx.actor.actorId}?t=${token}`;
          }
        }
      } catch {
        /* links optional — the WebUI Screen panel always works */
      }

      const sessionId = ctx.actor.sessionId;
      if (!sessionId) return { summary: "No session context for takeover.", isError: true };

      const rows = await db.select({ metadata: sessions.metadata }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      let meta: Record<string, unknown> = {};
      try {
        meta = rows[0]?.metadata ? JSON.parse(rows[0].metadata) : {};
      } catch {
        meta = {};
      }
      meta.pendingQuestion = `Take over my screen: ${input.reason}`;
      meta.pendingQuestionAgentId = ctx.actor.actorId;
      meta.pendingTakeover = { reason: input.reason };
      await db
        .update(sessions)
        .set({ metadata: JSON.stringify(meta), updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));

      return {
        summary: takeoverMessageText(input.reason, lanUrl),
        awaitUser: { question: `Take over my screen: ${input.reason}` },
      };
    },
  };

  return [readScreen, click, typeText, key, scroll, openApp, requestTakeover];
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}
