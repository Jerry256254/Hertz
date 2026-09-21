#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * RSS/Atom reader. Local connector, no credentials needed — reads any public
 * RSS 2.0 or Atom 1.0 feed over HTTP(S). The parser below is a small,
 * dependency-free XML reader that understands exactly what feeds need:
 * elements, attributes, CDATA, comments and namespace prefixes. It is not a
 * general XML parser.
 */

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

interface XNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XNode[];
}

/** Strip the namespace prefix: "content:encoded" -> "encoded". */
function localName(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name.toLowerCase() : name.slice(i + 1).toLowerCase();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseXml(src: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, text: "", children: [] };
  const stack: XNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      stack[stack.length - 1]!.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1]!.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      const cdata = end === -1 ? src.slice(lt + 9) : src.slice(lt + 9, end);
      // Decode entities in CDATA too: real-world feeds often escape "&" even
      // inside CDATA, and readers expect to see the plain character.
      stack[stack.length - 1]!.text += decodeEntities(cdata);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const gt = src.indexOf(">", lt + 1);
    if (gt === -1) break;
    const raw = src.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (raw.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (raw.startsWith("!")) continue; // <!DOCTYPE …> etc.
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const m = /^([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*$/.exec(body);
    if (!m) continue;
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[2] ?? "")) !== null) {
      attrs[am[1]!.toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
    }
    const node: XNode = { name: localName(m[1]!), attrs, text: "", children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function childText(node: XNode, name: string): string | undefined {
  for (const c of node.children) {
    if (c.name === name) return c.text.trim() || undefined;
  }
  return undefined;
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

interface FeedItem {
  title: string;
  link: string;
  published: string;
  summary: string;
}

/** Depth-first search for the first descendant with the given local name. */
function findFirst(node: XNode, name: string): XNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = findFirst(c, name);
    if (deep) return deep;
  }
  return undefined;
}

function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const root = parseXml(xml);
  const rss = findFirst(root, "rss");
  const channel = rss ? findFirst(rss, "channel") : undefined;
  const atom = !channel ? findFirst(root, "feed") : undefined;

  if (channel) {
    const items: FeedItem[] = [];
    for (const item of channel.children.filter((c) => c.name === "item")) {
      items.push({
        title: childText(item, "title") ?? "(bez názvu)",
        link: childText(item, "link") ?? "",
        published: childText(item, "pubdate") ?? childText(item, "date") ?? "",
        summary: stripHtml(childText(item, "encoded") ?? childText(item, "description") ?? "").slice(0, 2000),
      });
    }
    return { title: childText(channel, "title") ?? "(feed)", items };
  }
  if (atom) {
    const items: FeedItem[] = [];
    for (const entry of atom.children.filter((c) => c.name === "entry")) {
      const links = entry.children.filter((c) => c.name === "link");
      const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ?? links[0];
      items.push({
        title: stripHtml(childText(entry, "title") ?? "(bez názvu)"),
        link: alt?.attrs.href ?? "",
        published: childText(entry, "published") ?? childText(entry, "updated") ?? "",
        summary: stripHtml(childText(entry, "content") ?? childText(entry, "summary") ?? "").slice(0, 2000),
      });
    }
    return { title: stripHtml(childText(atom, "title") ?? "(feed)"), items };
  }
  throw new Error("V dokumentu nebyl nalezen RSS kanál ani Atom feed.");
}

async function fetchFeed(url: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Neplatná URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Povoleny jsou pouze adresy http(s).");
  }
  const res = await fetch(u, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "kuclab-hertz-mcp-rss/0.1.0", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
  });
  if (!res.ok) throw new Error(`Feed se nepodařilo stáhnout (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FEED_BYTES) throw new Error("Feed je příliš velký (> 2 MB).");
  return buf.toString("utf-8");
}

const server = new McpServer({ name: "kuclab-hertz-rss", version: "0.1.0" });

server.registerTool(
  "rss_read_feed",
  {
    description: "Read an RSS 2.0 or Atom 1.0 feed: returns the newest items with title, link, date and summary. Read-only.",
    inputSchema: {
      url: z.string().url().describe("Feed URL, e.g. 'https://example.com/feed.xml'"),
      limit: z.number().int().positive().max(50).optional().default(15).describe("Max items to return"),
    },
  },
  async ({ url, limit }) => {
    const xml = await fetchFeed(url);
    const feed = parseFeed(xml);
    const items = feed.items.slice(0, limit);
    if (items.length === 0) return { content: [{ type: "text", text: `Feed „${feed.title}" neobsahuje žádné položky.` }] };
    const text = items
      .map((it, i) => `${i + 1}. ${it.title}${it.published ? `\n   Datum: ${it.published}` : ""}${it.link ? `\n   Odkaz: ${it.link}` : ""}${it.summary ? `\n   ${it.summary}` : ""}`)
      .join("\n\n");
    return { content: [{ type: "text", text: `Feed: ${feed.title} (${feed.items.length} položek, zobrazuji ${items.length})\n\n${text}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
