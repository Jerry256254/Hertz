import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  url: z.string().url(),
});
type Input = z.infer<typeof inputSchema>;

const MAX_SUMMARY_CHARS = 4000;
const MAX_FETCH_BYTES = 2_000_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; KucLabHertz/0.1; +https://github.com/Jerry256254/HertzCli) AgentFetch";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code[0] === "#") {
      const codePoint = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[code] ?? match;
  });
}

function stripHtml(html: string): string {
  const withoutTags = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeEntities(withoutTags);
}

/** Node's built-in decoders cover utf-8 and the latin1/iso-8859-1 family; anything else falls back to utf-8. */
function bufferEncodingFor(contentType: string): BufferEncoding {
  const match = /charset=([^;]+)/i.exec(contentType);
  const charset = match?.[1]?.trim().toLowerCase();
  if (!charset || charset === "utf-8" || charset === "utf8") return "utf8";
  if (charset === "iso-8859-1" || charset === "latin1" || charset === "windows-1252") return "latin1";
  if (charset === "ascii" || charset === "us-ascii") return "ascii";
  return "utf8";
}

export const webFetchTool: ToolDef<Input> = {
  name: "web_fetch",
  description:
    "Fetch a URL over HTTP(S) and return its text content (HTML is stripped to plain text). Not a search engine — pass a specific URL. Google's search results page actively blocks non-browser requests and will not work; for web search use https://html.duckduckgo.com/html/?q=<query> instead, or fetch a specific known page directly.",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const url = new URL(input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { summary: `Blocked: unsupported protocol ${url.protocol}`, isError: true };
    }

    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow", headers: { "user-agent": USER_AGENT } });
    } catch (err) {
      return { summary: `Fetch failed: ${(err as Error).message}`, isError: true };
    }
    if (!res.ok) {
      return { summary: `Fetch failed: HTTP ${res.status}`, isError: true };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    const truncatedRaw = buf.byteLength > MAX_FETCH_BYTES;
    const text = buf.subarray(0, MAX_FETCH_BYTES).toString(bufferEncodingFor(contentType));
    const plain = contentType.includes("html") ? stripHtml(text) : text;

    const needsArtifact = plain.length > MAX_SUMMARY_CHARS || truncatedRaw;
    let artifactId: string | undefined;
    if (needsArtifact) {
      artifactId = await ctx.artifacts.store(ctx.actor.sessionId ?? "unknown", plain);
    }
    const excerpt = plain.slice(0, MAX_SUMMARY_CHARS);

    return {
      summary: `# ${input.url} (${contentType || "unknown type"})\n${excerpt}${needsArtifact ? "\n... [truncated, full content stored as artifact]" : ""}`,
      artifactId,
    };
  },
};
