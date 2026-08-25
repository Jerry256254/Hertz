import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  path: z.string().describe("Path relative to the project root"),
  startLine: z.number().int().positive().optional().describe("1-indexed, inclusive"),
  endLine: z.number().int().positive().optional().describe("1-indexed, inclusive"),
  root: z.string().optional().describe("Which root to read from — omit for the shared project root, or 'self' for your own personal folder (notes/materials/data)"),
});
type Input = z.infer<typeof inputSchema>;

const DEFAULT_MAX_LINES = 2000;

export const readFileTool: ToolDef<Input> = {
  name: "read_file",
  description:
    "Read a file, optionally restricted to a line range. Prefer a range for large files — reading the whole file wastes context. Pass root: 'self' to read from your own personal folder instead of the shared project.",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const abs = ctx.pathGuard.resolve(ctx.actor, input.root ?? ctx.rootId, input.path);
    try { const st = await fs.stat(abs); if (st.size > 5_000_000) return { summary: `File too large (${st.size} bytes) — max 5 MB — read a line range instead`, isError: true }; } catch {}
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch (err) {
      return { summary: `Could not read ${input.path}: ${(err as Error).message}`, isError: true };
    }

    const lines = raw.split("\n");
    const totalLines = lines.length;
    const start = Math.max(1, input.startLine ?? 1);
    const requestedEnd = input.endLine ?? start + DEFAULT_MAX_LINES - 1;
    const end = Math.min(totalLines, requestedEnd, start + DEFAULT_MAX_LINES - 1);
    const truncated = end < totalLines || start > 1;

    const numbered = lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}\t${l}`)
      .join("\n");

    const header = `# ${input.path} (lines ${start}-${end} of ${totalLines}${truncated ? ", truncated — pass startLine/endLine for more" : ""})`;
    return { summary: `${header}\n${numbered}` };
  },
};
