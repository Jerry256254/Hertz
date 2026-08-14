import { eq } from "drizzle-orm";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ALL_TOOLS, runTool, toProviderToolDefinitions } from "@kuclab-hertz/tools";
import type { AgentLoopManager, ToolPort } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { agents } from "../db/schema.js";
import { createOrgTools } from "./org-tools.js";
import type { SandboxRegistry } from "../sandbox/sandbox-registry.js";

export interface ToolPortDeps {
  db: Database;
  sandboxRegistry: SandboxRegistry;
  /** Lazy: AgentLoopManager depends on ToolPort, so ToolPort can't depend on a concrete instance at construction time. */
  getAgentLoop: () => AgentLoopManager;
}

function toJsonSchema(schema: import("zod").ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Only manager-role agents get the org-management tools (hire_employee, list_employees, assign_task). */
export function createToolPort(deps: ToolPortDeps): ToolPort {
  const orgTools = createOrgTools(deps);
  const orgToolsByName = new Map(orgTools.map((t) => [t.name, t]));
  const orgToolDefs = orgTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.inputSchema),
  }));
  const baseDefs = toProviderToolDefinitions(ALL_TOOLS);

  return {
    async listDefinitions(agentId) {
      const rows = await deps.db.select({ role: agents.role }).from(agents).where(eq(agents.id, agentId)).limit(1);
      return rows[0]?.role === "manager" ? [...baseDefs, ...orgToolDefs] : baseDefs;
    },
    run(name, input, ctx) {
      const orgTool = orgToolsByName.get(name);
      if (orgTool) return orgTool.execute(input, ctx);
      return runTool(name, input, ctx);
    },
  };
}
