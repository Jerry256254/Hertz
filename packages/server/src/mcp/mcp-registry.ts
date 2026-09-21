import { and, eq, isNull, or } from "drizzle-orm";
import { connectMcpServer, type McpConnection, type McpToolDef } from "@kuclab-hertz/mcp";
import type { ToolDefinition } from "@kuclab-hertz/providers";
import type { ToolResult } from "@kuclab-hertz/tools";
import type { Database } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { decryptSecret } from "../secrets/key-encryption.js";
import { CONNECTOR_CATALOG, connectorForServerArgs, type ConnectorId } from "./catalog.js";

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

/**
 * The on-demand catalog tool: always present, even with zero servers
 * connected. Lets the agent discover which one-click integrations exist
 * (Google, Notion, GitHub), which are already connected, and what each one
 * unlocks — so it only asks the user to connect what the task needs.
 * Connecting itself always happens in the user's browser (OAuth consent),
 * never by the agent.
 */
function catalogToolDefinition(): ToolDefinition {
  return {
    name: "mcp__catalog",
    description:
      "List available one-click integrations (Google = Gmail + Calendar + Drive, Notion, GitHub): what each one does and whether it is currently connected. " +
      "If a task needs a capability from a disconnected integration, tell the user (in Czech) to open Nastavení → Konektory and click Připojit — the OAuth consent must happen in their browser, you cannot connect it yourself. " +
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
 */
export class McpRegistry {
  private readonly cache = new Map<string, Promise<ConnectedServer>>();
  private readonly nameIndex = new Map<string, { serverId: string; toolName: string }>();

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

  async listToolDefinitions(agentId: string): Promise<ToolDefinition[]> {
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
      for (const tool of server.tools) {
        const prefixed = `mcp__${slug}__${tool.name}`;
        this.nameIndex.set(prefixed, { serverId: row.id, toolName: tool.name });
        defs.push({ name: prefixed, description: `[${row.name}] ${tool.description}`, inputSchema: tool.inputSchema });
      }
    }
    return defs;
  }

  /** For the Integrations UI: every MCP server row with its live tool list, without exposing them to the model. */
  async listAllForDisplay(): Promise<
    Array<{ serverId: string; serverName: string; connectorId: ConnectorId | null; enabled: boolean; tools: string[]; error?: string }>
  > {
    const rows = await this.db.select().from(mcpServers);
    return Promise.all(
      rows.map(async (row) => {
        const args = row.argsJson ? (JSON.parse(row.argsJson) as string[]) : [];
        const connectorId = connectorForServerArgs(args)?.id ?? null;
        if (!row.enabled) {
          return { serverId: row.id, serverName: row.name, connectorId, enabled: false, tools: [] as string[] };
        }
        const server = await this.getOrConnect(row);
        return {
          serverId: row.id,
          serverName: row.name,
          connectorId,
          enabled: true,
          tools: server.tools.map((t) => t.name),
          error: server.error,
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

  async run(name: string, input: unknown): Promise<ToolResult> {
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
    const entry = this.nameIndex.get(name);
    if (!entry) return { summary: `Unknown MCP tool: ${name}`, isError: true };

    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.id, entry.serverId)).limit(1);
    const row = rows[0];
    if (!row || !row.enabled) return { summary: `MCP server for ${name} is no longer available.`, isError: true };

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
