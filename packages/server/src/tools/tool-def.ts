import type { z } from "zod";
import type { ToolContext, ToolResult } from "@kuclab-hertz/tools";

/** A server-side tool definition (memory, shell, skills, browser, desktop, approvals). */
export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
