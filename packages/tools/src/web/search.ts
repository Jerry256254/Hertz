import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  query: z.string().min(1).max(500),
  count: z.number().int().min(1).max(10).optional().describe("How many results to return (default 5)"),
});
type Input = z.infer<typeof inputSchema>;

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/** No-key fallback: DuckDuckGo's HTML endpoint, parsed without dependencies. */
async function searchDuckDuckGo(query: string, count: number): Promise<SearchHit[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const html = await res.text();
  const hits: SearchHit[] = [];
  // Single pass over the document in order: a result__a anchor opens a new
  // result, the following result__snippet belongs to it. Pairing by index
  // across two separate loops broke whenever a result had no snippet.
  let pending: { title: string; url: string } | null = null;
  const flush = (snippet: string) => {
    if (!pending) return;
    const { title, url } = pending;
    pending = null;
    if (!/^https?:\/\//.test(url) || url.includes("duckduckgo.com")) return;
    if (hits.length >= count) return;
    hits.push({ title: title || url, url, snippet });
  };
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    const tag = m[1]!;
    const cls = /class="([^"]*)"/i.exec(tag)?.[1] ?? "";
    const isLink = cls.includes("result__a");
    const isSnippet = cls.includes("result__snippet");
    if (!isLink && !isSnippet) continue;
    if (isLink) {
      flush("");
      const href = /href="([^"]*)"/i.exec(tag)?.[1] ?? "";
      // DDG wraps outbound links as //duckduckgo.com/l/?uddg=<encoded-url>.
      const uddg = /[?&]uddg=([^&]+)/.exec(href)?.[1];
      const url = uddg ? decodeURIComponent(uddg) : href.startsWith("//") ? `https:${href}` : href;
      pending = { title: stripTags(m[2]!), url };
      if (hits.length >= count) break;
    } else {
      flush(stripTags(m[2]!));
    }
  }
  flush("");
  return hits;
}

async function searchTavily(query: string, count: number, apiKey: string): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: "basic" }),
  });
  if (!res.ok) throw new Error(`Tavily returned HTTP ${res.status}`);
  const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (json.results ?? []).map((r) => ({ title: r.title ?? r.url ?? "", url: r.url ?? "", snippet: (r.content ?? "").slice(0, 400) }));
}

async function searchBrave(query: string, count: number, apiKey: string): Promise<SearchHit[]> {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { "X-Subscription-Token": apiKey },
  });
  if (!res.ok) throw new Error(`Brave returned HTTP ${res.status}`);
  const json = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (json.web?.results ?? []).map((r) => ({ title: r.title ?? r.url ?? "", url: r.url ?? "", snippet: r.description ?? "" }));
}

async function searchSerper(query: string, count: number, apiKey: string): Promise<SearchHit[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ q: query, num: count }),
  });
  if (!res.ok) throw new Error(`Serper returned HTTP ${res.status}`);
  const json = (await res.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (json.organic ?? []).map((r) => ({ title: r.title ?? r.link ?? "", url: r.link ?? "", snippet: r.snippet ?? "" }));
}

export const webSearchTool: ToolDef<Input> = {
  name: "web_search",
  description:
    "Search the web and return titles, URLs, and snippets. Use this to find current information, then web_fetch the most promising URLs for full content. Works with no configuration (DuckDuckGo); set TAVILY_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY on the server for higher-quality results.",
  inputSchema,
  async execute(input, _ctx: ToolContext): Promise<ToolResult> {
    const count = input.count ?? 5;
    const attempts: Array<{ label: string; run: () => Promise<SearchHit[]> }> = [];
    if (process.env.TAVILY_API_KEY) {
      const key = process.env.TAVILY_API_KEY;
      attempts.push({ label: "Tavily", run: () => searchTavily(input.query, count, key) });
    }
    if (process.env.BRAVE_API_KEY) {
      const key = process.env.BRAVE_API_KEY;
      attempts.push({ label: "Brave", run: () => searchBrave(input.query, count, key) });
    }
    if (process.env.SERPER_API_KEY) {
      const key = process.env.SERPER_API_KEY;
      attempts.push({ label: "Serper", run: () => searchSerper(input.query, count, key) });
    }
    attempts.push({ label: "DuckDuckGo", run: () => searchDuckDuckGo(input.query, count) });

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const hits = await attempt.run();
        if (hits.length === 0) {
          errors.push(`${attempt.label}: no results`);
          continue;
        }
        const lines = hits.slice(0, count).map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet.slice(0, 300)}` : ""}`);
        return { summary: `Web results for "${input.query}" (via ${attempt.label}):\n${lines.join("\n")}` };
      } catch (err) {
        errors.push(`${attempt.label}: ${(err as Error).message}`);
      }
    }
    return { summary: `Web search failed: ${errors.join(" · ")}`, isError: true };
  },
};
