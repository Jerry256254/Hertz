import fs from "node:fs/promises";
import type { HertzPaths } from "@kuclab-hertz/server";

export interface HertzConfig {
  host: string;
  port: number;
}

const DEFAULT_CONFIG: HertzConfig = { host: "127.0.0.1", port: 4173 };

export async function loadConfig(paths: HertzPaths): Promise<HertzConfig | undefined> {
  try {
    const raw = await fs.readFile(paths.configPath, "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<HertzConfig>) };
  } catch {
    return undefined;
  }
}

export async function saveConfig(paths: HertzPaths, config: HertzConfig): Promise<void> {
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export { DEFAULT_CONFIG };
