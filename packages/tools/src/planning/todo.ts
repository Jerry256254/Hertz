import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const todoItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

const inputSchema = z.object({
  items: z.array(todoItemSchema),
});
type Input = z.infer<typeof inputSchema>;

const statusMark: Record<string, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

/**
 * Persistence of the current list is the agent loop's job (stored on the session,
 * not here) — this tool just validates the shape and renders it back so both the
 * model and the UI have a consistent, compact representation.
 */
export const todoWriteTool: ToolDef<Input> = {
  name: "todo_write",
  description: "Replace the current todo/plan list for this session with the given items.",
  inputSchema,
  async execute(input): Promise<ToolResult> {
    const rendered = input.items.map((i) => `${statusMark[i.status]} ${i.text}`).join("\n");
    return { summary: rendered || "(empty todo list)" };
  },
};
