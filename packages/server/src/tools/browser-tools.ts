import { z } from "zod";
import type { ToolContext, ToolResult } from "@kuclab-hertz/tools";
import type { AgentToolDef } from "./tool-def.js";
import { consumeVaultGrantForFill } from "./vault-tools.js";

/**
 * Browser automation for agents running in their own container — the
 * Grok-Bot-style "log into my apps and work there" capability. The Playwright
 * daemon keeps one Chromium alive across calls, so a login performed once
 * stays logged in for later actions; screenshots land in the agent's personal
 * materials folder where both the agent (read_file) and the user (file
 * explorer) can see them.
 */
export function createBrowserTools(): AgentToolDef[] {
  async function run(ctx: ToolContext, action: string, params: Record<string, unknown>): Promise<ToolResult> {
    if (!ctx.browser) {
      return {
        summary:
          "Browser tools need your own computer: ask the user to switch your computer backend to 'docker' and build the kuclab-hertz-computer image.",
        isError: true,
      };
    }
    const res = await ctx.browser.act(action, params);
    if (!res.ok) return { summary: `browser_${action} failed: ${res.error ?? "unknown error"}`, isError: true };
    const data = (res.data ?? {}) as Record<string, unknown>;
    const parts = Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}: ${String(v).slice(0, k === "text" ? 6000 : 300)}`);
    return { summary: parts.length > 0 ? parts.join("\n") : "done" };
  }

  const navigate: AgentToolDef = {
    name: "browser_navigate",
    description:
      "Open a URL in YOUR persistent browser (Chromium inside your computer). Logins survive across browser_* calls within a session. Returns title/URL; follow with browser_snapshot to read content.",
    inputSchema: z.object({ url: z.string().url() }),
    async execute(rawInput, ctx) {
      return run(ctx, "goto", z.object({ url: z.string().url() }).parse(rawInput));
    },
  };

  const snapshot: AgentToolDef = {
    name: "browser_snapshot",
    description: "Read the current page: URL, title, and visible text (truncated). Use after navigate/click to see what you're working with.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      return run(ctx, "snapshot", {});
    },
  };

  const click: AgentToolDef = {
    name: "browser_click",
    description: "Click something on the current page: either a CSS/xpath selector or visible text (use text for buttons/links). Waits briefly for navigation.",
    inputSchema: z.object({
      selector: z.string().optional().describe("CSS selector (or 'xpath=…'), e.g. '#login-button'"),
      text: z.string().optional().describe("Visible text of the element to click, e.g. 'Přihlásit se'"),
    }),
    async execute(rawInput, ctx) {
      const input = z.object({ selector: z.string().optional(), text: z.string().optional() }).parse(rawInput);
      if (!input.selector && !input.text) {
        return { summary: "Provide either selector or text.", isError: true };
      }
      return run(ctx, "click", input);
    },
  };

  const typeText: AgentToolDef = {
    name: "browser_type",
    description:
      "Type text into an input field (clears it first), e.g. login forms. Pair with browser_press('Enter') or browser_click on the submit button. To type a VAULT-APPROVED password without ever seeing it, pass vaultFill:true instead of text (needs a prior approved vault_use — the grant is single-use and expires after 5 minutes); the server substitutes the secret at execution time and it never appears in logs, history, or tool results.",
    inputSchema: z
      .object({
        selector: z.string(),
        text: z.string().max(10_000).optional(),
        vaultFill: z
          .boolean()
          .optional()
          .describe("Type the approved vault secret instead of text — single-use grant from vault_use"),
      })
      .refine((d) => (d.vaultFill ? d.text === undefined : typeof d.text === "string"), {
        message: "Pass either text or vaultFill:true, not both",
      }),
    async execute(rawInput, ctx) {
      const input = z
        .object({
          selector: z.string(),
          text: z.string().max(10_000).optional(),
          vaultFill: z.boolean().optional(),
        })
        .parse(rawInput);
      if (input.vaultFill) {
        if (input.text !== undefined) {
          return { summary: "Pass either text or vaultFill:true, not both.", isError: true };
        }
        if (!ctx.browser) {
          return {
            summary:
              "Browser tools need your own computer: ask the user to switch your computer backend to 'docker' and build the kuclab-hertz-computer image.",
            isError: true,
          };
        }
        const filled = consumeVaultGrantForFill(ctx.actor.sessionId);
        if ("error" in filled) return { summary: filled.error, isError: true };
        // Substitute server-side and bypass the generic summarizer: the
        // daemon must never echo the secret back into a tool result.
        const res = await ctx.browser.act("type", { selector: input.selector, text: filled.secret });
        if (!res.ok) return { summary: `browser_type (vault) failed: ${res.error ?? "unknown error"}`, isError: true };
        await ctx.audit.record({
          actorId: ctx.actor.actorId,
          actorType: "agent",
          sessionId: ctx.actor.sessionId ?? undefined,
          projectId: ctx.actor.projectId ?? undefined,
          action: "vault.fill",
          targetType: "vault_credential",
          result: "allowed",
          detail: { tool: "browser_type", label: filled.label },
        });
        return { summary: `Údaj z trezoru „${filled.label}" vyplněn do pole (hodnota skrytá).` };
      }
      if (typeof input.text !== "string") {
        return { summary: "Pass either text or vaultFill:true.", isError: true };
      }
      return run(ctx, "type", { selector: input.selector, text: input.text });
    },
  };

  const press: AgentToolDef = {
    name: "browser_press",
    description: "Press a keyboard key in the browser ('Enter', 'Escape', 'Tab', …).",
    inputSchema: z.object({ key: z.string().min(1) }),
    async execute(rawInput, ctx) {
      const input = z.object({ key: z.string().min(1) }).parse(rawInput);
      return run(ctx, "press", input);
    },
  };

  const screenshot: AgentToolDef = {
    name: "browser_screenshot",
    description:
      "Save a PNG of the current page into your materials folder (root 'self') so both you and the user can view it. Pass a path like 'materials/login-page.png'.",
    inputSchema: z.object({
      path: z.string().describe("Where to save, relative to your personal root, e.g. 'materials/screen.png'"),
      fullPage: z.boolean().optional(),
    }),
    async execute(rawInput, ctx) {
      const input = z.object({ path: z.string(), fullPage: z.boolean().optional() }).parse(rawInput);
      if (!ctx.browser) return run(ctx, "screenshot", input);
      // Resolve through the PathGuard so even browser writes stay inside the sandbox.
      let absolutePath: string;
      try {
        absolutePath = ctx.pathGuard.resolve(ctx.actor, "self", input.path);
      } catch (err) {
        return { summary: `Blocked: ${(err as Error).message}`, isError: true };
      }
      return run(ctx, "screenshot", { ...input, path: absolutePath });
    },
  };

  return [navigate, snapshot, click, typeText, press, screenshot];
}
