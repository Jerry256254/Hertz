import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  pattern: z.string().describe("Regular expression to search for"),
  glob: z.string().optional().default("**/*").describe("Restrict search to files matching this glob"),
  caseSensitive: z.boolean().optional().default(true),
  maxMatches: z.number().int().positive().max(200).optional().default(50),
});
type Input = z.infer<typeof inputSchema>;

interface Match {
  file: string;
  line: number;
  text: string;
}

export const grepTool: ToolDef<Input> = {
  name: "grep",
  description: "Search file contents for a regular expression, returning matching lines with file:line, not whole files.",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const root = ctx.pathGuard.getRoot(ctx.rootId);
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.caseSensitive ? "" : "i");
    } catch (err) {
      return { summary: `Invalid regular expression: ${(err as Error).message}`, isError: true };
    }

    const files = await fg(input.glob, {
      cwd: root,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    });

    const matches: Match[] = [];
    for (const rel of files) {
      if (matches.length >= input.maxMatches) break;
      let content: string;
      try {
        content = await fs.readFile(path.join(root, rel), "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < input.maxMatches; i++) {
        if (regex.test(lines[i]!)) {
          matches.push({ file: rel, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
        }
      }
    }

    const truncated = matches.length >= input.maxMatches;
    const body =
      matches.length > 0
        ? matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n")
        : "(no matches)";
    return {
      summary: `${matches.length} match(es) for /${input.pattern}/${truncated ? " (truncated, narrow the glob or pattern)" : ""}:\n${body}`,
    };
  },
};
