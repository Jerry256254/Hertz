import fg from "fast-glob";
import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'"),
  maxResults: z.number().int().positive().max(500).optional().default(200),
});
type Input = z.infer<typeof inputSchema>;

export const globTool: ToolDef<Input> = {
  name: "glob",
  description: "Find files matching a glob pattern within the project root, sorted by path.",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const root = ctx.pathGuard.getRoot(ctx.rootId);
    const matches = await fg(input.pattern, {
      cwd: root,
      dot: false,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    });
    matches.sort();
    const limited = matches.slice(0, input.maxResults);
    const truncated = matches.length > limited.length;
    const body = limited.length > 0 ? limited.join("\n") : "(no matches)";
    return {
      summary: `${limited.length} of ${matches.length} match(es) for "${input.pattern}"${truncated ? " (truncated)" : ""}:\n${body}`,
    };
  },
};
