import { z } from "zod";
import { execSandboxed } from "@kuclab-hertz/sandbox";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  command: z.string().describe("Bare binary name, e.g. 'git', not a path"),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional().default(".").describe("Directory relative to the project root"),
});
type Input = z.infer<typeof inputSchema>;

const SUMMARY_CHAR_LIMIT = 4000;

export const shellExecTool: ToolDef<Input> = {
  name: "shell_exec",
  description:
    "Run an allowlisted shell command (no shell interpreter — argv only, so no pipes/chaining) inside the project root.",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const cwd = ctx.pathGuard.resolve(ctx.actor, ctx.rootId, input.cwd);
    let result;
    try {
      result = await execSandboxed(
        ctx.shellPolicy,
        { command: input.command, args: input.args, cwd },
        ctx.actor,
        ctx.audit,
      );
    } catch (err) {
      return { summary: `Blocked: ${(err as Error).message}`, isError: true };
    }

    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n---stderr---\n");
    const needsArtifact = combined.length > SUMMARY_CHAR_LIMIT || result.truncated;
    let artifactId: string | undefined;
    if (needsArtifact) {
      artifactId = await ctx.artifacts.store(ctx.actor.sessionId ?? "unknown", combined);
    }
    const excerpt = combined.length > SUMMARY_CHAR_LIMIT ? combined.slice(0, SUMMARY_CHAR_LIMIT) : combined;

    const status = result.timedOut
      ? "timed out"
      : `exit code ${result.exitCode}`;
    return {
      summary: `$ ${input.command} ${input.args.join(" ")}\n(${status})\n${excerpt}${needsArtifact ? "\n... [truncated, full output stored as artifact]" : ""}`,
      artifactId,
      isError: result.exitCode !== 0 || result.timedOut,
    };
  },
};
