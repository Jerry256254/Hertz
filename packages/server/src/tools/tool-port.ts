import { z } from "zod";import { zodToJsonSchema } from "zod-to-json-schema";
import { eq } from "drizzle-orm";
import { agents } from "../db/schema.js";
import { ALL_TOOLS, runTool, toProviderToolDefinitions } from "@kuclab-hertz/tools";
import type { AgentLoopManager, PersistencePort, ProviderPort, ToolPort } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import type { AgentToolDef } from "./tool-def.js";
import { createMemoryTools } from "./memory-tools.js";
import { createOnboardingTools } from "./onboarding-tools.js";
import { createIdentityTools } from "./identity-tools.js";
import { createShellTools } from "./shell-tools.js";
import { createApprovalTools } from "./approval-tools.js";
import { createHostAccessTools } from "./host-access-tools.js";
import { createVaultTools } from "./vault-tools.js";
import { createSkillTools } from "./skill-tools.js";
import { createBrowserTools } from "./browser-tools.js";
import { createDesktopTools } from "./desktop-tools.js";
import { createContextTools } from "./context-tools.js";
import { createSubagentTools } from "./subagent-tools.js";
import { createFileTools } from "./file-tools.js";
import type { SubagentManager } from "../agents/subagents.js";
import { recordToolStep } from "../memory/short-term.js";
import { resolveAgentProjectId } from "../memory/recall.js";
import type { DesktopManager } from "../computer/desktop-manager.js";
import type { SandboxRegistry } from "../sandbox/sandbox-registry.js";
import type { HertzPaths } from "../paths.js";
import { McpRegistry } from "../mcp/mcp-registry.js";
import type { ShellManager } from "../shells/shell-manager.js";
import type { JobQueue } from "../queue/job-queue.js";

export interface ToolPortDeps {
  db: Database;
  paths: HertzPaths;
  sandboxRegistry: SandboxRegistry;
  mcpRegistry: McpRegistry;
  shellManager: ShellManager;
  providers: ProviderPort;
  queue: JobQueue;
  persistence: PersistencePort;
  masterKey: Buffer;
  desktop: DesktopManager;
  /** Lazy: AgentLoopManager depends on ToolPort, so ToolPort can't depend on a concrete instance at construction time. */
  getAgentLoop: () => AgentLoopManager;
  /** Lazy for the same reason: SubagentManager needs the AgentLoopManager. */
  getSubagents: () => SubagentManager;
}

function toJsonSchema(schema: import("zod").ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function toDefs(tools: AgentToolDef[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: toJsonSchema(t.inputSchema) }));
}

/** Asks the human user a question and stops until they answer (auto mode only — withheld in plan/autonomous). */
const ASK_USER_DEF: AgentToolDef = {
  name: "ask_user",
  description:
    "Ask the human user a single, concrete question you genuinely cannot resolve yourself (a preference, a decision, missing information only they have). The run pauses and the question is shown in the UI with an answer field; you continue when they answer. Don't use it for things you can decide or look up yourself.",
  inputSchema: z.object({ question: z.string().min(1).describe("The question, phrased so it can be answered with a short text") }),
  async execute() {
    return { summary: "Question sent to the user — waiting for their answer in the UI." };
  },
};

/**
 * The single agent gets everything: base fs/shell/web/todo tools plus memory,
 * shells, approvals, skills, browser, desktop, MCP and ask_user. No roles, no
 * gates — one superintelligent agent with full tool access.
 */
export function createToolPort(deps: ToolPortDeps): ToolPort {
  const memoryTools = createMemoryTools(deps.db, deps.paths);
  const onboardingTools = createOnboardingTools(deps.db);
  const identityTools = createIdentityTools(deps.db);
  const shellTools = createShellTools(deps.db, deps.shellManager);
  const approvalTools = createApprovalTools(deps.db);
  const hostAccessTools = createHostAccessTools(deps.db);
  const vaultTools = createVaultTools(deps.db, deps.masterKey);
  const skillTools = createSkillTools(deps.db, deps.paths);
  const browserTools = createBrowserTools();
  const desktopTools = createDesktopTools(deps.db, deps.masterKey, deps.desktop);
  const contextTools = createContextTools(deps.db);
  const subagentTools = createSubagentTools(deps.getSubagents);
  const fileTools = createFileTools(deps.db);
  const allByName = new Map(
    [...memoryTools, ...onboardingTools, ...identityTools, ...shellTools, ...approvalTools, ...hostAccessTools, ...vaultTools, ...skillTools, ...browserTools, ...desktopTools, ...contextTools, ...subagentTools, ...fileTools, ASK_USER_DEF].map((t) => [t.name, t]),
  );

  const baseDefs = toProviderToolDefinitions(ALL_TOOLS);
  const memoryDefs = toDefs(memoryTools);
  const onboardingDefs = toDefs(onboardingTools);
  const identityDefs = toDefs(identityTools);
  const shellDefs = toDefs(shellTools);
  const approvalDefs = [...toDefs(approvalTools), ...toDefs(hostAccessTools)];
  const vaultDefs = toDefs(vaultTools);
  const skillDefs = toDefs(skillTools);
  const computerDefs = [...toDefs(browserTools), ...toDefs(desktopTools)];
  const contextDefs = toDefs(contextTools);
  const subagentDefs = toDefs(subagentTools);
  const fileDefs = toDefs(fileTools);
  const askUserDefs = toDefs([ASK_USER_DEF]);

  return {
    async listDefinitions(agentId) {
      const mcpDefs = await deps.mcpRegistry.listToolDefinitions(agentId);
      let defs = [...baseDefs, ...memoryDefs, ...onboardingDefs, ...identityDefs, ...shellDefs, ...approvalDefs, ...vaultDefs, ...skillDefs, ...computerDefs, ...contextDefs, ...subagentDefs, ...fileDefs, ...mcpDefs, ...askUserDefs];
      // complete_onboarding is single-use: hide it once the agent is onboarded
      // so it never wastes context or gets called twice.
      const rows = await deps.db
        .select({ onboardedAt: agents.onboardedAt })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
        .catch(() => []);
      if (rows[0]?.onboardedAt) defs = defs.filter((d) => d.name !== "complete_onboarding");
      return defs;
    },
    async run(name, input, ctx) {
      const tool = allByName.get(name);
      let result: Awaited<ReturnType<typeof runTool>>;
      if (deps.mcpRegistry.isMcpTool(name)) {
        // Předáme kontext aktéra, aby citlivé MCP operace mohly založit
        // schvalovací žádost (kind "mcp_op") a zaparkovat sezení.
        result = await deps.mcpRegistry.run(name, input, {
          agentId: ctx.actor.actorId,
          projectId: ctx.actor.projectId,
          sessionId: ctx.actor.sessionId,
        });
      } else if (tool) {
        result = await tool.execute(input, ctx);
      } else {
        result = await runTool(name, input, ctx);
      }
      // Short-term symbolic memory: every step lands on the session canvas;
      // heavy outputs spill to refs/<nodeId>.md so the history (and every
      // future turn's context) carries a pointer instead of kilobytes.
      const sessionId = ctx.actor.sessionId;
      if (sessionId) {
        try {
          // Canvas lives in the agent's home (his own project, cached lookup).
          const projectId = await resolveAgentProjectId(deps.db, ctx.actor.actorId);
          if (projectId) {
            const recorded = await recordToolStep({
              paths: deps.paths,
              projectId,
              agentId: ctx.actor.actorId,
              sessionId,
              tool: name,
              input,
              summary: result.summary,
              isError: result.isError,
            });
            if (recorded.offloaded) result = { ...result, summary: recorded.summary };
          }
        } catch {
          /* memory recording must never break a tool call */
        }
      }
      return result;
    },
  };
}
