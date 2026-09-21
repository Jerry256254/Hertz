import fs from "node:fs/promises";
import { z } from "zod";
import type { HertzPaths } from "@kuclab-hertz/server";

export interface HertzConfig {
  host: string;
  port: number;
}

const DEFAULT_CONFIG: HertzConfig = { host: "127.0.0.1", port: 4173 };

const configSchema = z.object({
  host: z.string().min(1, "host must be a non-empty string"),
  port: z.number().int("port must be an integer").min(1, "port must be >= 1").max(65535, "port must be <= 65535"),
});

export const DEFAULT_HOST = DEFAULT_CONFIG.host;

/**
 * Returns undefined when no config file exists yet (first run). A file that
 * exists but is broken or invalid fails loudly with a readable error instead
 * of silently falling back and then crashing in app.listen.
 */
export async function loadConfig(paths: HertzPaths): Promise<HertzConfig | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read config at ${paths.configPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`Invalid JSON in config at ${paths.configPath}: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse({ ...DEFAULT_CONFIG, ...(parsed as Record<string, unknown>) });
  if (!result.success) {
    throw new Error(`Invalid config at ${paths.configPath}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return result.data;
}

export async function saveConfig(paths: HertzPaths, config: HertzConfig): Promise<void> {
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export { DEFAULT_CONFIG };
