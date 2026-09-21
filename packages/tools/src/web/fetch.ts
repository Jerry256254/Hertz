import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import net from "node:net";
import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  url: z.string().url(),
});
type Input = z.infer<typeof inputSchema>;

const MAX_SUMMARY_CHARS = 4000;
const MAX_FETCH_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; KucLabHertz/0.1; +https://github.com/Jerry256254/Hertz) AgentFetch";

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

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (cloud metadata)
    a === 0 // 0.0.0.0/8
  );
}

function isBlockedIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]!;
  // IPv4-mapped ::ffff:a.b.c.d — judge by the embedded IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isBlockedIPv4(mapped[1]!);
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  const firstHextet = parseInt(addr.split(":")[0] ?? "", 16);
  if (Number.isFinite(firstHextet)) {
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  }
  return false;
}

function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return false;
}

/**
 * SSRF guard: refuse URLs whose hostname is a private/loopback address or
 * resolves to one. We resolve the hostname (checking ALL returned addresses)
 * but still fetch against the original hostname so TLS certificates match —
 * the residual DNS-rebinding window is accepted, the common cases are blocked.
 */
async function assertPublicUrl(url: URL): Promise<string | undefined> {
  // url.hostname keeps brackets around IPv6 literals — strip them for net.isIP.
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "Blocked: localhost is not a fetchable target";
  }
  if (net.isIP(host) !== 0) {
    if (isBlockedIp(host)) return `Blocked: ${host} is a private/loopback address`;
    return undefined;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    return `Blocked: could not resolve ${host}`;
  }
  const bad = addresses.find((a) => isBlockedIp(a.address));
  if (bad) return `Blocked: ${host} resolves to a private/loopback address`;
  return undefined;
}

export const webFetchTool: ToolDef<Input> = {
  name: "web_fetch",
  description:
    "Fetch a URL over HTTP(S) and return its text content (HTML is stripped to plain text). Not a search engine — pass a specific URL (use web_search to find pages first). Search-result pages that block non-browser requests will not work; fetch a specific page directly instead.",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const url = new URL(input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { summary: `Blocked: unsupported protocol ${url.protocol}`, isError: true };
    }

    // Follow redirects manually so every hop passes the SSRF guard.
    let res: Response | undefined;
    let current: URL = url;
    for (let hop = 0; hop < 6; hop++) {
      const blocked = await assertPublicUrl(current);
      if (blocked) {
        return { summary: blocked, isError: true };
      }
      try {
        res = await fetch(current, {
          redirect: "manual",
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        return { summary: `Fetch failed: ${(err as Error).message}`, isError: true };
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current);
        if (current.protocol !== "http:" && current.protocol !== "https:") {
          return { summary: `Blocked: redirect to unsupported protocol ${current.protocol}`, isError: true };
        }
        continue;
      }
      break;
    }
    if (!res) {
      return { summary: "Fetch failed: too many redirects", isError: true };
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
