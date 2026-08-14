import { zodToJsonSchema } from "zod-to-json-schema";
import { readFileTool } from "./fs/read.js";
import { writeFileTool } from "./fs/write.js";
import { editFileTool } from "./fs/edit.js";
import { globTool } from "./fs/glob.js";
import { grepTool } from "./fs/grep.js";
import { shellExecTool } from "./shell/exec.js";
import { webFetchTool } from "./web/fetch.js";
import { todoWriteTool } from "./planning/todo.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

export const ALL_TOOLS: ToolDef[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  shellExecTool,
  webFetchTool,
  todoWriteTool,
];

const toolsByName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return toolsByName.get(name);
}

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return { summary: `Unknown tool: ${name}`, isError: true };
  }
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { summary: `Invalid input for ${name}: ${parsed.error.message}`, isError: true };
  }
  try {
    return await tool.execute(parsed.data, ctx);
  } catch (err) {
    return { summary: `${name} failed: ${(err as Error).message}`, isError: true };
  }
}

/**
 * JSON-schema tool definitions in the shape provider adapters expect.
 *
 * Deliberately NOT using target:"openApi3" here: that target renders
 * exclusiveMinimum/exclusiveMaximum as booleans (the old OpenAPI 3.0 /
 * JSON-Schema-draft-4 style), which strict OpenAI-compatible tool-schema
 * validators reject outright ("True is not of type 'number'"). The default
 * target (JSON Schema draft-7) renders them as numbers, which is what every
 * provider's function-calling schema actually expects.
 */
export function toProviderToolDefinitions(tools: ToolDef[] = ALL_TOOLS) {
  return tools.map((t) => {
    const schema = zodToJsonSchema(t.inputSchema) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description,
      inputSchema: schema,
    };
  });
}
