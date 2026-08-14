import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  path: z.string().describe("Path relative to the project root"),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional().default(false),
});
type Input = z.infer<typeof inputSchema>;

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) return count;
    count++;
    idx += needle.length;
  }
}

export const editFileTool: ToolDef<Input> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. oldString must match exactly once unless replaceAll is set.",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const abs = ctx.pathGuard.resolve(ctx.actor, ctx.rootId, input.path);
    const raw = await fs.readFile(abs, "utf8");
    const occurrences = countOccurrences(raw, input.oldString);

    if (occurrences === 0) {
      return { summary: `oldString not found in ${input.path}`, isError: true };
    }
    if (occurrences > 1 && !input.replaceAll) {
      return {
        summary: `oldString matches ${occurrences} times in ${input.path} — pass replaceAll or provide more context to make it unique`,
        isError: true,
      };
    }

    const updated = input.replaceAll
      ? raw.split(input.oldString).join(input.newString)
      : raw.replace(input.oldString, input.newString);

    await fs.writeFile(abs, updated, "utf8");
    return { summary: `Replaced ${input.replaceAll ? occurrences : 1} occurrence(s) in ${input.path}` };
  },
};
