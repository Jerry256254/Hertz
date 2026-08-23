import { z } from "zod";
import { execSandboxed, isCommandAllowed } from "@kuclab-hertz/sandbox";
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

    // Inside the agent's own container: the allowlist still applies (the host
    // side validates the command name before dispatching), but execution
    // happens in the agent's isolated machine, not on the server.
    if (ctx.computer) {
      if (!isCommandAllowed(ctx.shellPolicy, input.command)) {
        ctx.audit.record({
          ...ctx.actor,
          action: "shell.computer.exec",
          target: input.command,
          targetType: "command",
          result: "denied",
          detail: { reason: "not allowlisted" },
        });
        return {
          summary: `Blocked: "${input.command}" isn't on this project's command allowlist. Run unrestricted commands through a persistent shell instead (create_shell / run_in_shell).`,
          isError: true,
        };
      }
      let result;
      try {
        result = await ctx.computer.exec({ command: input.command, args: input.args, cwd });
      } catch (err) {
        return { summary: `Computer exec failed: ${(err as Error).message}`, isError: true };
      }
      ctx.audit.record({
        ...ctx.actor,
        action: "shell.computer.exec",
        target: input.command,
        targetType: "command",
        result: "allowed",
        detail: { args: input.args, exitCode: result.exitCode },
      });
      const combinedC = [result.stdout, result.stderr].filter(Boolean).join("\n---stderr---\n");
      const needsArtifactC = combinedC.length > SUMMARY_CHAR_LIMIT || result.truncated;
      const artifactIdC = needsArtifactC ? await ctx.artifacts.store(ctx.actor.sessionId ?? "unknown", combinedC) : undefined;
      const excerptC = combinedC.length > SUMMARY_CHAR_LIMIT ? combinedC.slice(0, SUMMARY_CHAR_LIMIT) : combinedC;
      const statusC = result.timedOut ? "timed out" : `exit code ${result.exitCode}`;
      return {
        summary: `$ ${input.command} ${input.args.join(" ")}\n(${statusC})\n${excerptC}${needsArtifactC ? "\n... [truncated, full output stored as artifact]" : ""}`,
        artifactId: artifactIdC,
        isError: result.exitCode !== 0 || result.timedOut,
      };
    }

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
