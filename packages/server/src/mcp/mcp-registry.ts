import { and, eq, isNull, or } from "drizzle-orm";
import { connectMcpServer, type McpConnection, type McpToolDef } from "@kuclab-hertz/mcp";
import type { ToolDefinition } from "@kuclab-hertz/providers";
import type { ToolResult } from "@kuclab-hertz/tools";
import type { Database } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { decryptSecret } from "../secrets/key-encryption.js";

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
    const defs: ToolDefinition[] = [];
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
