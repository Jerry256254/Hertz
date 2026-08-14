import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  url: z.string().url(),
});
type Input = z.infer<typeof inputSchema>;

const MAX_SUMMARY_CHARS = 4000;
const MAX_FETCH_BYTES = 2_000_000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const webFetchTool: ToolDef<Input> = {
  name: "web_fetch",
  description: "Fetch a URL over HTTP(S) and return its text content (HTML is stripped to plain text).",
  inputSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const url = new URL(input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { summary: `Blocked: unsupported protocol ${url.protocol}`, isError: true };
    }

    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow" });
    } catch (err) {
      return { summary: `Fetch failed: ${(err as Error).message}`, isError: true };
    }
    if (!res.ok) {
      return { summary: `Fetch failed: HTTP ${res.status}`, isError: true };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    const truncatedRaw = buf.byteLength > MAX_FETCH_BYTES;
    const text = buf.subarray(0, MAX_FETCH_BYTES).toString("utf8");
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
