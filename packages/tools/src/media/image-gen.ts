import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const inputSchema = z.object({
  prompt: z.string().min(1).max(2000).describe("What to depict — concrete subjects, style, and mood work best"),
  size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).optional().describe("Output size (default 1024x1024)"),
});
type Input = z.infer<typeof inputSchema>;

const MAX_IMAGE_BYTES = 6_000_000;

function parseSize(size: string): { width: number; height: number } {
  const [w, h] = size.split("x").map(Number);
  return { width: w || 1024, height: h || 1024 };
}

async function generateWithOpenAI(prompt: string, size: string, apiKey: string): Promise<{ mimeType: string; data: string; url?: string }> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "dall-e-3", prompt, size, quality: "standard", response_format: "b64_json" }),
  });
  if (!res.ok) throw new Error(`OpenAI image API returned HTTP ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
  const first = json.data?.[0];
  if (!first?.b64_json) throw new Error("OpenAI returned no image data");
  return { mimeType: "image/png", data: first.b64_json, url: first.url };
}

/** Free, keyless generation via Pollinations (FLUX). Quality varies; no account needed. */
async function generateWithPollinations(prompt: string, size: string): Promise<{ mimeType: string; data: string; url: string }> {
  const { width, height } = parseSize(size);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&model=flux`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pollinations returned HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("Generated image exceeds size limit");
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  return { mimeType, data: buf.toString("base64"), url };
}

export const imageGenTool: ToolDef<Input> = {
  name: "generate_image",
  description:
    "Generate an image from a text description. The image is shown to the user and (for vision models) back to you for verification. Works with no configuration (free Pollinations/FLUX backend); set OPENAI_API_KEY on the server for higher-quality DALL-E output.",
  inputSchema,
  async execute(input, _ctx: ToolContext): Promise<ToolResult> {
    const size = input.size ?? "1024x1024";
    const errors: string[] = [];

    if (process.env.OPENAI_API_KEY) {
      try {
        const img = await generateWithOpenAI(input.prompt, size, process.env.OPENAI_API_KEY);
        return {
          summary: `Image generated (${size}, DALL-E). It is attached below — describe or verify it as needed.`,
          attachments: [{ mimeType: img.mimeType, data: img.data }],
        };
      } catch (err) {
        errors.push(`OpenAI: ${(err as Error).message}`);
      }
    }

    try {
      const img = await generateWithPollinations(input.prompt, size);
      return {
        summary: `Image generated (${size}, free FLUX backend). Direct URL: ${img.url}${errors.length ? ` (OpenAI failed: ${errors.join("; ")})` : ""}`,
        attachments: [{ mimeType: img.mimeType, data: img.data }],
      };
    } catch (err) {
      errors.push(`Pollinations: ${(err as Error).message}`);
    }
    return { summary: `Image generation failed: ${errors.join(" · ")}`, isError: true };
  },
};
