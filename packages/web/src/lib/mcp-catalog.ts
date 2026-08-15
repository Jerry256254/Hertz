export type McpCredentialField = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  helpText?: string;
};

export type McpCatalogEntry = {
  id: string;
  name: string;
  category: "development" | "productivity" | "communication" | "data";
  description: string;
  /** First letter shown in the tile when there's no dedicated icon — kept simple and text-based like the rest of the UI. */
  letter: string;
} & (
  | { transport: "stdio"; command: string; args: string[]; credentials: McpCredentialField[] }
  | { transport: "sse"; url: string; credentials: McpCredentialField[] }
);

/**
 * Presets for well-known MCP servers, each declaring exactly the credential(s)
 * its own server package actually needs. This is NOT an OAuth broker — there's
 * no registered Google/Slack/GitHub OAuth app behind this (that requires the
 * app owner's own client id/secret, which a self-hosted tool can't fabricate).
 * "Connect" collects the token/credential the real server expects and stores
 * it encrypted, the same as a provider API key — honest about what it is.
 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    category: "development",
    description: "Issues, PRs, repo search, and file contents via the official GitHub MCP server.",
    letter: "G",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    credentials: [
      { key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub personal access token", secret: true, placeholder: "ghp_…" },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    category: "communication",
    description: "Read and post to channels via a Slack bot token.",
    letter: "S",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    credentials: [
      { key: "SLACK_BOT_TOKEN", label: "Bot token", secret: true, placeholder: "xoxb-…" },
      { key: "SLACK_TEAM_ID", label: "Team ID", placeholder: "T0123456" },
    ],
  },
  {
    id: "postgres",
    name: "Postgres",
    category: "data",
    description: "Read-only schema inspection and queries against a Postgres database.",
    letter: "P",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    credentials: [{ key: "connectionString", label: "Connection string", secret: true, placeholder: "postgres://user:pass@host/db" }],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "productivity",
    description: "Search and read files. Needs your own Google Cloud OAuth client — self-hosted, not Anthropic's managed connector.",
    letter: "D",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    credentials: [
      { key: "GDRIVE_OAUTH_CLIENT_ID", label: "OAuth client ID", helpText: "From your own Google Cloud project" },
      { key: "GDRIVE_OAUTH_CLIENT_SECRET", label: "OAuth client secret", secret: true },
      { key: "GDRIVE_OAUTH_REFRESH_TOKEN", label: "OAuth refresh token", secret: true },
    ],
  },
  {
    id: "memory",
    name: "Knowledge graph memory",
    category: "productivity",
    description: "A shared, queryable memory graph the server maintains for itself — separate from an employee's own remember/forget notes.",
    letter: "M",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    credentials: [],
  },
  {
    id: "puppeteer",
    name: "Browser automation",
    category: "development",
    description: "Drive a real headless browser — click, fill forms, screenshot pages.",
    letter: "B",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    credentials: [],
  },
];

export const MCP_CATEGORY_LABEL: Record<McpCatalogEntry["category"], string> = {
  development: "Development",
  productivity: "Productivity",
  communication: "Communication",
  data: "Data",
};
