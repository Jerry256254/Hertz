import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: string;
  isError?: boolean;
}

export type McpTransportConfig =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "sse"; url: string; headers?: Record<string, string> };

export interface McpConnection {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, input: unknown): Promise<McpToolResult>;
  close(): Promise<void>;
}

/**
 * One live connection to one MCP server (a local subprocess for stdio, or an
 * HTTP+SSE endpoint for sse). Deliberately thin: this package's only job is
 * translating the MCP SDK's shapes into the plain listTools/callTool contract
 * the server's tool-port merges alongside the built-in fs/shell/web toolset —
 * it doesn't know about agents, DB rows, or encryption; that's the caller's job.
 */
export async function connectMcpServer(displayName: string, config: McpTransportConfig): Promise<McpConnection> {
  const client = new Client({ name: `kuclab-hertz-${displayName}`, version: "0.1.0" }, { capabilities: {} });

  const transport =
    config.transport === "stdio"
      ? new StdioClientTransport({ command: config.command, args: config.args ?? [], env: config.env })
      : new SSEClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });

  await client.connect(transport);

  return {
    async listTools() {
      const res = await client.listTools();
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      }));
    },

    async callTool(toolName, input) {
      const res = await client.callTool({ name: toolName, arguments: (input ?? {}) as Record<string, unknown> });
      const blocks = Array.isArray((res as { content?: unknown }).content)
        ? ((res as { content: unknown[] }).content as Array<{ type: string; text?: string }>)
        : [];
      const content =
        blocks.length > 0
          ? blocks.map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type} content]`)).join("\n")
          : JSON.stringify(res);
      return { content, isError: Boolean((res as { isError?: boolean }).isError) };
    },

    async close() {
      await client.close();
    },
  };
}
