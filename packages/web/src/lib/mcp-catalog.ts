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
  /** When set, "Connect" redirects to a real OAuth consent screen instead of opening a credential form — see routes/oauth.ts. */
  oauth?: { service: "google" | "slack" };
} & (
  | { transport: "stdio"; command: string; args: string[]; credentials: McpCredentialField[] }
  | { transport: "sse"; url: string; credentials: McpCredentialField[] }
);

/**
 * Presets for well-known MCP servers. Entries with `oauth` set connect via a
 * real authorization-code flow (the CEO registers a Client ID/Secret once in
 * Integrations → OAuth apps, using their own Google Cloud / Slack app — a
 * self-hosted tool has no OAuth app of its own to broker through). Entries
 * without `oauth` collect exactly the credential their server package needs
 * (a token, a connection string) and store it encrypted, same as a provider
 * API key.
 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "gmail",
    name: "Gmail",
    category: "communication",
    description: "Search, read, and send email from the connected Gmail account.",
    letter: "M",
    oauth: { service: "google" },
    transport: "stdio",
    command: "node",
    args: [],
    credentials: [],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "productivity",
    description: "Search and read files from the connected Google Drive account.",
    letter: "D",
    oauth: { service: "google" },
    transport: "stdio",
    command: "node",
    args: [],
    credentials: [],
  },
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
      { key: "GITHUB_USERNAME", label: "GitHub username", placeholder: "octocat" },
      { key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "Personal access token", secret: true, placeholder: "ghp_…" },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    category: "communication",
    description: "Read and post to channels in the connected Slack workspace.",
    letter: "S",
    oauth: { service: "slack" },
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
