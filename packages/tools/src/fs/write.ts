import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  path: z.string().describe("Path relative to the project root"),
  content: z.string(),
  root: z.string().optional().describe("Which root to write to — omit for the shared project root, or 'self' for your own personal folder (notes/materials/data)"),
});
type Input = z.infer<typeof inputSchema>;

export const writeFileTool: ToolDef<Input> = {
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Creates parent directories as needed. Pass root: 'self' to write into your own personal folder instead of the shared project.",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const abs = ctx.pathGuard.resolve(ctx.actor, input.root ?? ctx.rootId, input.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, "utf8");
    const bytes = Buffer.byteLength(input.content, "utf8");
    return { summary: `Wrote ${bytes} bytes to ${input.path}` };
  },
};
