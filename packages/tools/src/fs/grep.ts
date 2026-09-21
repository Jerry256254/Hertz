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
  root: z.string().optional().describe("Which root to search — omit for the shared project root, 'self' for your own personal folder, or a folder name from Your folders"),
});
type Input = z.infer<typeof inputSchema>;

interface Match {
  file: string;
  line: number;
  text: string;
}

const MAX_GREP_BYTES = 5_000_000;

export const grepTool: ToolDef<Input> = {
  name: "grep",
  description: "Search file contents for a regular expression, returning matching lines with file:line, not whole files. Text tool — never use desktop_* / browser_* for file work.",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const root = ctx.pathGuard.getRoot(input.root ?? ctx.rootId);
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
    const skippedLarge: string[] = [];
    for (const rel of files) {
      if (matches.length >= input.maxMatches) break;
      let content: string;
      try {
        const abs = path.join(root, rel);
        const st = await fs.stat(abs);
        if (st.size > MAX_GREP_BYTES) {
          skippedLarge.push(rel);
          continue;
        }
        content = await fs.readFile(abs, "utf8");
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
    const skippedNote =
      skippedLarge.length > 0
        ? ` (skipped ${skippedLarge.length} file(s) over 5 MB: ${skippedLarge.slice(0, 3).join(", ")}${skippedLarge.length > 3 ? ", …" : ""})`
        : "";
    return {
      summary: `${matches.length} match(es) for /${input.pattern}/${truncated ? " (truncated, narrow the glob or pattern)" : ""}${skippedNote}:\n${body}`,
    };
  },
};
