import { and, eq, isNull, or } from "drizzle-orm";
import { connectMcpServer, type McpConnection, type McpToolDef } from "@kuclab-hertz/mcp";
import type { ToolDefinition } from "@kuclab-hertz/providers";
import type { ToolResult } from "@kuclab-hertz/tools";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { approvals, auditLog, mcpServers, sessions } from "../db/schema.js";
import { decryptSecret } from "../secrets/key-encryption.js";
import { hasSessionApproval, sessionApprovalKey } from "../tools/session-approval-grants.js";
import { CONNECTOR_CATALOG, connectorForServerArgs, type ConnectorId } from "./catalog.js";
import {
  classifyTool,
  defaultPolicy,
  describeForAgent,
  enforcePolicy,
  parsePolicy,
  type ConnectorPolicy,
  type McpOpPayload,
  type ToolClass,
} from "./tool-policy.js";

type McpServerRow = typeof mcpServers.$inferSelect;

interface ConnectedServer {
  tools: McpToolDef[];
  connection?: McpConnection;
  error?: string;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "server";
}

/** Context the tool-port passes so the registry can file approvals. */
export interface McpExecContext {
  agentId?: string;
  projectId?: string | null;
  sessionId?: string | null;
}

interface ToolIndexEntry {
  serverId: string;
  serverName: string;
  toolName: string;
  toolClass: ToolClass;
  requiresApproval: boolean;
}

/**
 * The on-demand catalog tool: always present, even with zero servers
 * connected. Lets the agent discover which one-click integrations exist
 * (Google, Notion, GitHub, Prezentace), which are already connected, and what
 * each one unlocks — so it only asks the user to connect what the task needs.
 * Connecting itself always happens in the user's browser (OAuth consent),
 * never by the agent. The local Prezentace connector is enabled with one
 * click in Nastavení → Konektory, no login needed.
 */
function catalogToolDefinition(): ToolDefinition {
  return {
    name: "mcp__catalog",
    description:
      "List available one-click integrations (Google = Gmail + Calendar + Drive + Sheets + Docs, Notion, GitHub, Prezentace = local presentation builder): what each one does and whether it is currently connected. " +
      "If a task needs a capability from a disconnected integration, tell the user (in Czech) to open Nastavení → Konektory and click Připojit (or Zapnout for Prezentace) — the OAuth consent must happen in their browser, you cannot connect it yourself. " +
      "Never invent tool names from this catalog: only call the concrete mcp__<server>__<tool> tools listed as connected.",
    inputSchema: { type: "object", properties: {} },
  };
}

/**
 * Holds one live connection per enabled MCP server row, keyed by row id, and
 * merges their tools into the agent's toolset under an `mcp__<server>__<tool>`
 * name (collisions with built-in/org/memory tool names, or between two MCP
 * tools, are avoided by that prefix). A server that fails to connect doesn't
 * take the rest of the tool-port down with it — it shows up as a single
 * `..._unavailable` tool whose description carries the error, so the agent
 * (and the user, via the Integrations UI) can see what's wrong instead of the
 * failure being silent.
 *
 * Every call additionally passes through the per-connector security policy
 * (mcp/tool-policy.ts): connectors default to read-only, individual tools can
 * be allow/denied per connector, and sensitive operations (sending e-mail,
 * deleting, publishing, overwriting) always file a user approval
 * (kind "mcp_op") instead of executing — even in read-write mode.
 */
export class McpRegistry {
  private readonly cache = new Map<string, Promise<ConnectedServer>>();
  private readonly nameIndex = new Map<string, ToolIndexEntry>();
  /** Tools hidden by per-tool deny: not listed, but calling them yields a clear Czech error instead of "unknown tool". */
  private readonly deniedIndex = new Map<string, { serverId: string; serverName: string; toolName: string }>();

  constructor(
    private readonly db: Database,
    private readonly masterKey: Buffer,
  ) {}

  /** Call after any create/update/delete/enable-toggle so the next tool call picks up the change. */
  invalidate(serverId: string): void {
    const pending = this.cache.get(serverId);
    this.cache.delete(serverId);
    if (pending) void pending.then((s) => s.connection?.close()).catch(() => {});
  }

  /**
   * "Otestovat připojení" for the Integrations UI: force a fresh connection
   * attempt (bypasses the cache so a previously failed server is really
   * retried) and report whether it works. A working connection stays cached.
   */
  async testConnection(serverId: string): Promise<{ ok: boolean; error?: string }> {
    const row = await this.rowById(serverId);
    if (!row) return { ok: false, error: "Server nenalezen." };
    if (!row.enabled) return { ok: false, error: "Server je vypnutý." };
    this.invalidate(serverId);
    const fresh = await this.connect(row);
    if (fresh.error) return { ok: false, error: fresh.error };
    this.cache.set(serverId, Promise.resolve(fresh));
    return { ok: true };
  }

  /** Close every live MCP connection (stdio child processes, SSE streams). Call on app/test teardown. */
  async shutdown(): Promise<void> {
    const pending = [...this.cache.values()];
    this.cache.clear();
    this.invalidateIndex();
    await Promise.all(pending.map((p) => p.then((s) => s.connection?.close()).catch(() => {})));
  }

  /** Rebuild the name indexes (call after a policy change; listToolDefinitions also refreshes them). */
  invalidateIndex(): void {
    this.nameIndex.clear();
    this.deniedIndex.clear();
  }

  private buildConfig(row: McpServerRow): { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> } | { transport: "sse"; url: string; headers?: Record<string, string> } {
    const secret = row.encryptedEnv ? (JSON.parse(decryptSecret(this.masterKey, row.encryptedEnv)) as Record<string, string>) : undefined;
    if (row.transport === "stdio") {
      return { transport: "stdio", command: row.command ?? "", args: row.argsJson ? (JSON.parse(row.argsJson) as string[]) : [], env: secret };
    }
    return { transport: "sse", url: row.url ?? "", headers: secret };
  }

  private async connect(row: McpServerRow): Promise<ConnectedServer> {
    try {
      const connection = await connectMcpServer(row.name, this.buildConfig(row));
      const tools = await connection.listTools();
      return { tools, connection };
    } catch (err) {
      return { tools: [], error: (err as Error).message };
    }
  }

  private getOrConnect(row: McpServerRow): Promise<ConnectedServer> {
    let pending = this.cache.get(row.id);
    if (!pending) {
      pending = this.connect(row);
      this.cache.set(row.id, pending);
    }
    return pending;
  }

  /** Global (agentId null) servers plus any scoped to this specific agent. */
  private async rowsForAgent(agentId: string): Promise<McpServerRow[]> {
    return this.db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.enabled, true), or(isNull(mcpServers.agentId), eq(mcpServers.agentId, agentId))));
  }

  private async rowById(serverId: string): Promise<McpServerRow | undefined> {
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).limit(1);
    return rows[0];
  }

  policyFor(row: McpServerRow): ConnectorPolicy {
    // Rows created before the policy columns existed carry NULLs — parsePolicy
    // treats those as the least-privilege default (read-only).
    return parsePolicy(row.policyMode ?? undefined, row.policyToolsJson ?? undefined);
  }

  private describeWithPolicyNote(tool: McpToolDef, serverName: string, policy: ConnectorPolicy): string {
    const cls = classifyTool(tool.name);
    const note = describeForAgent(tool.name, cls, policy.mode);
    const base = `[${serverName}] ${tool.description ?? ""}`;
    return note ? `${base} [${note}]` : base;
  }

  private indexTool(prefixed: string, row: McpServerRow, tool: McpToolDef, policy: ConnectorPolicy): ToolDefinition | null {
    if ((policy.tools[tool.name] ?? "allow") === "deny") {
      this.deniedIndex.set(prefixed, { serverId: row.id, serverName: row.name, toolName: tool.name });
      return null;
    }
    const cls = classifyTool(tool.name);
    this.nameIndex.set(prefixed, {
      serverId: row.id,
      serverName: row.name,
      toolName: tool.name,
      toolClass: cls,
      requiresApproval: cls === "sensitive",
    });
    return { name: prefixed, description: this.describeWithPolicyNote(tool, row.name, policy), inputSchema: tool.inputSchema };
  }

  async listToolDefinitions(agentId: string): Promise<ToolDefinition[]> {
    this.invalidateIndex();
    const rows = await this.rowsForAgent(agentId);
    const defs: ToolDefinition[] = [catalogToolDefinition()];
    for (const row of rows) {
      const slug = slugify(row.name);
      const server = await this.getOrConnect(row);
      if (server.error) {
        defs.push({
          name: `mcp__${slug}__unavailable`,
          description: `MCP server "${row.name}" is not reachable right now (${server.error}). Do not call this — it always fails.`,
          inputSchema: { type: "object", properties: {} },
        });
        continue;
      }
      const policy = this.policyFor(row);
      for (const tool of server.tools) {
        const def = this.indexTool(`mcp__${slug}__${tool.name}`, row, tool, policy);
        if (def) defs.push(def);
      }
    }
    return defs;
  }

  /** Policy view of one server row for the Integrations UI (no secrets). */
  policyView(row: McpServerRow, tools: string[]): {
    mode: ConnectorPolicy["mode"];
    tools: Array<{ name: string; class: ToolClass; requiresApproval: boolean; allowed: boolean }>;
  } {
    const policy = this.policyFor(row);
    return {
      mode: policy.mode,
      tools: tools.map((name) => {
        const cls = classifyTool(name);
        return { name, class: cls, requiresApproval: cls === "sensitive", allowed: (policy.tools[name] ?? "allow") === "allow" };
      }),
    };
  }

  /** For the Integrations UI: every MCP server row with its live tool list, without exposing them to the model. */
  async listAllForDisplay(): Promise<
    Array<{ serverId: string; serverName: string; connectorId: ConnectorId | null; enabled: boolean; tools: string[]; error?: string; policy: ReturnType<McpRegistry["policyView"]> }>
  > {
    const rows = await this.db.select().from(mcpServers);
    return Promise.all(
      rows.map(async (row) => {
        const args = row.argsJson ? (JSON.parse(row.argsJson) as string[]) : [];
        const connectorId = connectorForServerArgs(args)?.id ?? null;
        if (!row.enabled) {
          return { serverId: row.id, serverName: row.name, connectorId, enabled: false, tools: [] as string[], policy: this.policyView(row, []) };
        }
        const server = await this.getOrConnect(row);
        const tools = server.tools.map((t) => t.name);
        return {
          serverId: row.id,
          serverName: row.name,
          connectorId,
          enabled: true,
          tools,
          error: server.error,
          policy: this.policyView(row, tools),
        };
      }),
    );
  }

  /** Live connection status of every catalog connector (for the `mcp__catalog` tool and the Integrations UI). */
  async catalogStatus(): Promise<
    Array<{ id: ConnectorId; name: string; tagline: string; connected: boolean; tools: string[]; error?: string }>
  > {
    const display = await this.listAllForDisplay();
    return CONNECTOR_CATALOG.map((def) => {
      const servers = display.filter((s) => s.connectorId === def.id && s.enabled);
      const tools = servers.flatMap((s) => s.tools.map((t) => `mcp__${slugify(s.serverName)}__${t}`));
      const error = servers.map((s) => s.error).find(Boolean);
      return { id: def.id, name: def.name, tagline: def.tagline, connected: servers.length > 0, tools, error };
    });
  }

  /** For the Integrations UI: which MCP tools a given agent currently has, without exposing them to the model. */
  async listForDisplay(agentId: string): Promise<Array<{ serverId: string; serverName: string; tools: string[]; error?: string }>> {
    const rows = await this.rowsForAgent(agentId);
    return Promise.all(
      rows.map(async (row) => {
        const server = await this.getOrConnect(row);
        return { serverId: row.id, serverName: row.name, tools: server.tools.map((t) => t.name), error: server.error };
      }),
    );
  }

  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  /**
   * Files a user approval for a sensitive MCP operation (kind "mcp_op") and
   * parks the session — mirrors request_host_access. On approve the approvals
   * route executes the call via executeApprovedOp and resumes the agent.
   */
  private async fileSensitiveApproval(entry: ToolIndexEntry, input: unknown, exec: McpExecContext): Promise<ToolResult> {
    const { agentId, projectId, sessionId } = exec;
    if (!agentId || !projectId || !sessionId) {
      return {
        summary:
          `Citlivá operace „${entry.toolName}“ (${entry.serverName}) vyžaduje schválení uživatele, ` +
          `ale volání nemá kontext sezení — schválení nelze vyžádat. Operace nebyla provedena.`,
        isError: true,
      };
    }

    const summary = `Citlivá operace: ${entry.toolName} (${entry.serverName})`;
    const payload: McpOpPayload = { serverId: entry.serverId, serverName: entry.serverName, toolName: entry.toolName, input };
    const id = newId();
    // "Povolit pro session": the user pre-approved this exact tool — the
    // server executes it right away, exactly like a one-shot approval.
    if (hasSessionApproval(sessionId, sessionApprovalKey("mcp_op", `${entry.serverId}:${entry.toolName}`))) {
      await this.db.insert(auditLog).values({
        id: newId(),
        actorId: agentId,
        actorType: "agent",
        sessionId,
        projectId,
        action: "mcp_op.approved",
        target: `${entry.serverName}:${entry.toolName}`,
        targetType: "mcp_tool",
        result: "allowed",
        detail: JSON.stringify({ serverId: entry.serverId, toolName: entry.toolName, via: "session_grant" }),
        at: new Date(),
      });
      const direct = await this.executeApprovedOp(entry.serverId, entry.toolName, input);
      return {
        summary: `[Automaticky schváleno pro tuto session] ${direct.summary}`,
        isError: direct.isError,
      };
    }
    await this.db.insert(approvals).values({
      id,
      projectId,
      agentId,
      sessionId,
      summary,
      detail:
        `Agent chce spustit citlivý nástroj konektoru „${entry.serverName}“:\n` +
        `nástroj: ${entry.toolName}\n` +
        `vstup: ${JSON.stringify(input)}\n\n` +
        `Po schválení operaci provede server sám a agentovi předá výsledek. Po zamítnutí se nic nestane.`,
      kind: "mcp_op",
      payload: JSON.stringify(payload),
      createdAt: new Date(),
    });

    const rows = await this.db.select({ metadata: sessions.metadata }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    let meta: Record<string, unknown> = {};
    try {
      meta = rows[0]?.metadata ? (JSON.parse(rows[0].metadata) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    await this.db
      .update(sessions)
      .set({
        metadata: JSON.stringify({ ...meta, pendingQuestion: `Schválení potřeba: ${summary}`, pendingApprovalId: id }),
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));

    await this.db.insert(auditLog).values({
      id: newId(),
      actorId: agentId,
      actorType: "agent",
      sessionId,
      projectId,
      action: "mcp_op.request",
      target: `${entry.serverName}:${entry.toolName}`,
      targetType: "mcp_tool",
      result: "allowed",
      detail: JSON.stringify({ serverId: entry.serverId, toolName: entry.toolName, approvalId: id }),
      at: new Date(),
    });

    return {
      summary: `Citlivá operace „${entry.toolName}“ (${entry.serverName}) vyžaduje schválení uživatele — žádost („${summary}“) je ve schvalovací schránce. Čekám na rozhodnutí.`,
      awaitUser: { question: `Schválení potřeba: ${summary}` },
    };
  }

  /**
   * Executes a previously approved sensitive op (called by the approvals
   * route after the user approves). Skips the approval gate — the user just
   * approved this exact call — but still honors per-tool deny and the
   * server's enabled flag.
   */
  async executeApprovedOp(serverId: string, toolName: string, input: unknown): Promise<ToolResult> {
    const row = await this.rowById(serverId);
    if (!row || !row.enabled) return { summary: `MCP server pro schválenou operaci už není dostupný.`, isError: true };
    const policy = this.policyFor(row);
    if ((policy.tools[toolName] ?? "allow") === "deny") {
      return { summary: `Nástroj „${toolName}“ je v nastavení konektoru „${row.name}“ zakázán — ani schválená operace se nespustí.`, isError: true };
    }
    const server = await this.getOrConnect(row);
    if (server.error || !server.connection) {
      return { summary: `MCP server „${row.name}“ není dostupný: ${server.error ?? "neznámá chyba"}`, isError: true };
    }
    try {
      const result = await server.connection.callTool(toolName, input);
      return { summary: result.content, isError: result.isError };
    } catch (err) {
      return { summary: `Schválená MCP operace selhala: ${(err as Error).message}`, isError: true };
    }
  }

  async run(name: string, input: unknown, exec: McpExecContext = {}): Promise<ToolResult> {
    if (name === "mcp__catalog") {
      const status = await this.catalogStatus();
      const lines = status.map((c) => {
        const head = `- ${c.id}: ${c.name} — ${c.tagline} [${c.connected ? "connected" : "not connected"}]`;
        const tools = c.connected && c.tools.length > 0 ? `\n  tools: ${c.tools.join(", ")}` : "";
        const err = c.error ? `\n  WARNING: connection error: ${c.error}` : "";
        return head + tools + err;
      });
      return {
        summary:
          `Available one-click integrations (user connects them in Nastavení → Konektory):\n${lines.join("\n")}\n` +
          `To use a disconnected integration, ask the user (in Czech) to connect it there first.`,
      };
    }
    if (name.endsWith("__unavailable")) {
      return { summary: "This MCP server is unavailable.", isError: true };
    }
    const denied = this.deniedIndex.get(name);
    if (denied) {
      return {
        summary: `Nástroj „${denied.toolName}“ je v Nastavení → Konektory u konektoru „${denied.serverName}“ zakázán. Nebyl spuštěn. Pokud ho úkol vyžaduje, požádej uživatele (česky), aby ho povolil.`,
        isError: true,
      };
    }
    const entry = this.nameIndex.get(name);
    if (!entry) return { summary: `Unknown MCP tool: ${name}`, isError: true };

    const row = await this.rowById(entry.serverId);
    if (!row || !row.enabled) return { summary: `MCP server pro ${name} už není dostupný.`, isError: true };

    const policy = this.policyFor(row);
    const outcome = enforcePolicy(policy, entry.toolName);
    if (outcome.verdict === "deny-tool") {
      return {
        summary: `Nástroj „${entry.toolName}“ je v Nastavení → Konektory u konektoru „${entry.serverName}“ zakázán. Nebyl spuštěn.`,
        isError: true,
      };
    }
    if (outcome.verdict === "deny-read-only") {
      return {
        summary:
          `Konektor „${entry.serverName}“ je v režimu jen pro čtení — zápisová operace „${entry.toolName}“ je zablokována a nebyla provedena. ` +
          `Pokud má agent zapisovat, musí uživatel v Nastavení → Konektory přepnout konektor na „Čtení a zápis“.`,
        isError: true,
      };
    }
    if (outcome.verdict === "approval-required") {
      return this.fileSensitiveApproval(entry, input, exec);
    }

    const server = await this.getOrConnect(row);
    if (server.error || !server.connection) return { summary: `MCP server "${row.name}" is not reachable: ${server.error ?? "unknown error"}`, isError: true };

    try {
      const result = await server.connection.callTool(entry.toolName, input);
      return { summary: result.content, isError: result.isError };
    } catch (err) {
      return { summary: `MCP call failed: ${(err as Error).message}`, isError: true };
    }
  }
}
