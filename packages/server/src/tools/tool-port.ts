import { eq } from "drizzle-orm";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ALL_TOOLS, runTool, toProviderToolDefinitions } from "@kuclab-hertz/tools";
import type { AgentLoopManager, ToolPort } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { agents } from "../db/schema.js";
import { createOrgTools, type OrgToolDef } from "./org-tools.js";
import { createMemoryTools } from "./memory-tools.js";
import { createMessagingTools } from "./messaging-tools.js";
import type { SandboxRegistry } from "../sandbox/sandbox-registry.js";
import type { HertzPaths } from "../paths.js";
import { McpRegistry } from "../mcp/mcp-registry.js";

export interface ToolPortDeps {
  db: Database;
  paths: HertzPaths;
  sandboxRegistry: SandboxRegistry;
  mcpRegistry: McpRegistry;
  /** Lazy: AgentLoopManager depends on ToolPort, so ToolPort can't depend on a concrete instance at construction time. */
  getAgentLoop: () => AgentLoopManager;
}

function toJsonSchema(schema: import("zod").ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function toDefs(tools: OrgToolDef[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: toJsonSchema(t.inputSchema) }));
}

/**
 * Every agent gets the base fs/shell/web/todo tools plus memory (remember/
 * list_memory/forget). Only manager-role agents additionally get the
 * org-management tools (hire_employee, list_employees, assign_task).
 */
export function createToolPort(deps: ToolPortDeps): ToolPort {
  const orgTools = createOrgTools(deps);
  const memoryTools = createMemoryTools(deps.db, deps.paths);
  const messagingTools = createMessagingTools(deps.db);
  const allByName = new Map([...orgTools, ...memoryTools, ...messagingTools].map((t) => [t.name, t]));

  const baseDefs = toProviderToolDefinitions(ALL_TOOLS);
  const memoryDefs = toDefs(memoryTools);
  const messagingDefs = toDefs(messagingTools);
  const orgDefs = toDefs(orgTools);

  return {
    async listDefinitions(agentId) {
      const rows = await deps.db.select({ role: agents.role }).from(agents).where(eq(agents.id, agentId)).limit(1);
      const mcpDefs = await deps.mcpRegistry.listToolDefinitions(agentId);
      const defs = [...baseDefs, ...memoryDefs, ...messagingDefs, ...mcpDefs];
      return rows[0]?.role === "manager" ? [...defs, ...orgDefs] : defs;
    },
    run(name, input, ctx) {
      if (deps.mcpRegistry.isMcpTool(name)) return deps.mcpRegistry.run(name, input);
      const tool = allByName.get(name);
      if (tool) return tool.execute(input, ctx);
      return runTool(name, input, ctx);
    },
  };
}
