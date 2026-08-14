import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STANDARD_MD_PATH = path.join(__dirname, "kuclab.standard.md");

export const kuclabConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  enforceStandard: z.boolean().default(true),
  license: z.string().default("MIT"),
  copyrightHolder: z.string().default("KucLab"),
  commitLanguage: z.enum(["en", "cs"]).default("en"),
  category: z.string().optional(),
});
export type KucLabConfig = z.infer<typeof kuclabConfigSchema>;

let cachedStandardText: string | undefined;

/** The standard is already condensed by design — loaded once and reused verbatim, not re-summarized per session. */
export async function loadStandardText(): Promise<string> {
  if (!cachedStandardText) {
    cachedStandardText = await fs.readFile(STANDARD_MD_PATH, "utf8");
  }
  return cachedStandardText;
}

export async function loadProjectConfig(projectRoot: string): Promise<KucLabConfig> {
  const configPath = path.join(projectRoot, "kuclab.config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return kuclabConfigSchema.parse(JSON.parse(raw));
  } catch {
    return kuclabConfigSchema.parse({});
  }
}

/**
 * Token-efficient system-prompt fragment for a project: the condensed standard
 * plus this project's overrides. Cache-eligible as part of the static system
 * prompt under the 'anthropic-breakpoints' strategy since it doesn't change
 * within a session.
 */
export async function buildStandardContext(projectRoot: string): Promise<string> {
  const [standard, config] = await Promise.all([
    loadStandardText(),
    loadProjectConfig(projectRoot),
  ]);
  if (!config.enforceStandard) return "";
  return `${standard}\n\n<!-- project overrides: license=${config.license}, holder=${config.copyrightHolder}, commitLanguage=${config.commitLanguage} -->`;
}
