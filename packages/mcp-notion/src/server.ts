#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiKey = process.env.NOTION_API_KEY;
/** Overridable for tests/QA — production default is the real Notion API. */
const apiBase = (process.env.NOTION_API_BASE ?? "https://api.notion.com").replace(/\/$/, "");
const NOTION_VERSION = "2022-06-28";

if (!apiKey) {
  console.error("mcp-notion: missing NOTION_API_KEY");
  process.exit(1);
}

interface RichTextItem {
  plain_text?: string;
}

function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return (rich as RichTextItem[]).map((r) => r.plain_text ?? "").join("");
}

function titleOf(page: any): string {
  const props = page?.properties ?? {};
  for (const prop of Object.values(props) as any[]) {
    if (prop?.type === "title") return plainText(prop.title);
  }
  return "(untitled)";
}

/**
 * Every request goes through here so auth headers are set in exactly one
 * place — and so a failed call can never leak the API key into the error
 * text (only status + Notion's message are surfaced).
 */
async function notionFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${apiBase}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 500);
    try {
      detail = (JSON.parse(body) as { message?: string }).message ?? detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`Notion API error ${res.status}: ${detail}`);
  }
  return body ? JSON.parse(body) : {};
}

function blockText(block: any): string | null {
  const type = block?.type as string | undefined;
  if (!type) return null;
  const data = block[type] as { rich_text?: unknown; checked?: boolean } | undefined;
  if (!data || !Array.isArray(data.rich_text)) return null;
  const text = plainText(data.rich_text);
  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `[${data.checked ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    case "callout":
      return `> ${text}`;
    default:
      return text || null;
  }
}

async function pageContentText(pageId: string): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 5; pages++) {
    const res: any = await notionFetch(
      `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    );
    for (const block of res.results ?? []) {
      const t = blockText(block);
      if (t) lines.push(t);
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return lines.join("\n");
}

function flattenProperties(properties: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, prop] of Object.entries(properties ?? {})) {
    switch (prop?.type) {
      case "title":
        out[name] = plainText(prop.title);
        break;
      case "rich_text":
        out[name] = plainText(prop.rich_text);
        break;
      case "number":
        out[name] = prop.number == null ? "" : String(prop.number);
        break;
      case "select":
        out[name] = prop.select?.name ?? "";
        break;
      case "multi_select":
        out[name] = (prop.multi_select ?? []).map((s: any) => s.name).join(", ");
        break;
      case "date":
        out[name] = prop.date ? `${prop.date.start ?? ""}${prop.date.end ? ` → ${prop.date.end}` : ""}` : "";
        break;
      case "checkbox":
        out[name] = prop.checkbox ? "true" : "false";
        break;
      case "url":
        out[name] = prop.url ?? "";
        break;
      case "email":
        out[name] = prop.email ?? "";
        break;
      case "phone_number":
        out[name] = prop.phone_number ?? "";
        break;
      case "status":
        out[name] = prop.status?.name ?? "";
        break;
      case "created_time":
        out[name] = prop.created_time ?? "";
        break;
      case "last_edited_time":
        out[name] = prop.last_edited_time ?? "";
        break;
      default:
        break;
    }
  }
  return out;
}

const server = new McpServer({ name: "kuclab-hertz-notion", version: "0.1.0" });

server.registerTool(
  "notion_search",
  {
    description: "Search Notion pages and databases by title text.",
    inputSchema: {
      query: z.string().describe("Text to search for in titles"),
      kind: z.enum(["page", "database"]).optional().describe("Only return pages or databases"),
      pageSize: z.number().int().positive().max(50).optional().default(10),
    },
  },
  async ({ query, kind, pageSize }) => {
    const res: any = await notionFetch("/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        page_size: pageSize,
        ...(kind ? { filter: { property: "object", value: kind } } : {}),
      }),
    });
    const results = res.results ?? [];
    if (results.length === 0) return { content: [{ type: "text", text: "No pages or databases matched." }] };
    const text = results
      .map((r: any) => `[${r.id}] (${r.object}) ${titleOf(r)}${r.url ? ` — ${r.url}` : ""}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "notion_get_page",
  {
    description: "Read a Notion page's title and full text content by page id.",
    inputSchema: { pageId: z.string().describe("Page id (dashes optional)") },
  },
  async ({ pageId }) => {
    const page: any = await notionFetch(`/pages/${pageId}`);
    const text = await pageContentText(pageId);
    return { content: [{ type: "text", text: `# ${titleOf(page)}\n\n${text || "(no text content)"}` }] };
  },
);

server.registerTool(
  "notion_query_database",
  {
    description: "Query a Notion database and list matching rows with their properties.",
    inputSchema: {
      databaseId: z.string().describe("Database id"),
      query: z.string().optional().describe("Text matched against the database's title property"),
      pageSize: z.number().int().positive().max(50).optional().default(10),
    },
  },
  async ({ databaseId, query, pageSize }) => {
    const res: any = await notionFetch(`/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ ...(query ? { query } : {}), page_size: pageSize }),
    });
    const rows = res.results ?? [];
    if (rows.length === 0) return { content: [{ type: "text", text: "No rows matched." }] };
    const text = rows
      .map((r: any) => {
        const props = flattenProperties(r.properties);
        const kv = Object.entries(props)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" | ");
        return `[${r.id}] ${kv}`;
      })
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "notion_create_page",
  {
    description: "Create a Notion page: as a sub-page of a parent page, or as a row in a database (title property is detected automatically).",
    inputSchema: {
      parentId: z.string().describe("Parent page id, or database id when parentType is 'database'"),
      parentType: z.enum(["page", "database"]).optional().default("page"),
      title: z.string().describe("Page title"),
      content: z.string().optional().describe("Body text; blank lines separate paragraphs"),
    },
  },
  async ({ parentId, parentType, title, content }) => {
    let properties: Record<string, unknown>;
    if (parentType === "database") {
      const db: any = await notionFetch(`/databases/${parentId}`);
      const titleProp = Object.entries<any>(db.properties ?? {}).find(([, p]) => p?.type === "title");
      if (!titleProp) throw new Error("notion_create_page: the database has no title property");
      properties = { [titleProp[0]]: { title: [{ text: { content: title } }] } };
    } else {
      properties = { title: { title: [{ text: { content: title } }] } };
    }
    const children = (content ?? "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((paragraph) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: paragraph } }] } }));
    const page: any = await notionFetch("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: parentType === "database" ? { database_id: parentId } : { page_id: parentId },
        properties,
        ...(children.length > 0 ? { children } : {}),
      }),
    });
    return { content: [{ type: "text", text: `Created page "${title}" (id ${page.id}). ${page.url ?? ""}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
