import { eq } from "drizzle-orm";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ALL_TOOLS, runTool, toProviderToolDefinitions } from "@kuclab-hertz/tools";
import type { AgentLoopManager, ProviderPort, ToolPort } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { agents } from "../db/schema.js";
import { createOrgTools, type OrgToolDef } from "./org-tools.js";
import { createMemoryTools } from "./memory-tools.js";
import { createMessagingTools } from "./messaging-tools.js";
import { createShellTools } from "./shell-tools.js";
import type { SandboxRegistry } from "../sandbox/sandbox-registry.js";
import type { HertzPaths } from "../paths.js";
import { McpRegistry } from "../mcp/mcp-registry.js";
import type { ShellManager } from "../shells/shell-manager.js";

export interface ToolPortDeps {
  db: Database;
  paths: HertzPaths;
  sandboxRegistry: SandboxRegistry;
  mcpRegistry: McpRegistry;
  shellManager: ShellManager;
  providers: ProviderPort;
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
 * Managers keep read-only tools (for reviewing what employees produced) but
 * lose direct write access — otherwise it's too easy for a manager to just do
 * the work itself instead of hiring/briefing employees for it, which defeats
 * the entire point of the org structure. This is enforced here, not just in
 * the system prompt, so it holds even if a model ignores its instructions.
 */
const MANAGER_RESTRICTED_TOOLS = new Set(["write_file", "edit_file", "shell_exec"]);

/**
 * Every agent gets the base fs/shell/web/todo tools plus memory (remember/
 * list_memory/forget). Manager-role agents additionally get the org-
 * management tools (hire_employee, list_employees, assign_task) but lose
 * MANAGER_RESTRICTED_TOOLS — see above.
 */
export function createToolPort(deps: ToolPortDeps): ToolPort {
  const orgTools = createOrgTools(deps);
  const memoryTools = createMemoryTools(deps.db, deps.paths);
  const messagingTools = createMessagingTools(deps.db);
  const shellTools = createShellTools(deps.db, deps.shellManager);
  const allByName = new Map([...orgTools, ...memoryTools, ...messagingTools, ...shellTools].map((t) => [t.name, t]));

  const baseDefs = toProviderToolDefinitions(ALL_TOOLS);
  const memoryDefs = toDefs(memoryTools);
  const messagingDefs = toDefs(messagingTools);
  const shellDefs = toDefs(shellTools);
  const orgDefs = toDefs(orgTools);

  async function isManager(agentId: string): Promise<boolean> {
    const rows = await deps.db.select({ role: agents.role }).from(agents).where(eq(agents.id, agentId)).limit(1);
    return rows[0]?.role === "manager";
  }

  return {
    async listDefinitions(agentId) {
      const managerRole = await isManager(agentId);
      const mcpDefs = await deps.mcpRegistry.listToolDefinitions(agentId);
      const filteredBaseDefs = managerRole ? baseDefs.filter((d) => !MANAGER_RESTRICTED_TOOLS.has(d.name)) : baseDefs;
      const defs = [...filteredBaseDefs, ...memoryDefs, ...messagingDefs, ...shellDefs, ...mcpDefs];
      return managerRole ? [...defs, ...orgDefs] : defs;
    },
    async run(name, input, ctx) {
      if (deps.mcpRegistry.isMcpTool(name)) return deps.mcpRegistry.run(name, input);
      const tool = allByName.get(name);
      if (tool) return tool.execute(input, ctx);
      if (MANAGER_RESTRICTED_TOOLS.has(name) && ctx.actor.actorType === "agent" && (await isManager(ctx.actor.actorId))) {
        return {
          summary: "As the manager you don't have direct write access — hire the right role with hire_employee if you don't have them yet, then delegate this with assign_task.",
          isError: true,
        };
      }
      return runTool(name, input, ctx);
    },
  };
}
