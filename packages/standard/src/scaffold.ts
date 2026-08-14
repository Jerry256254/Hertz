import fs from "node:fs/promises";
import path from "node:path";
import { kuclabConfigSchema, type KucLabConfig } from "./standard-loader.js";

/** Writes a starter kuclab.config.json into a project root (used by the "scaffold KucLab standard" UI action). */
export async function scaffoldKucLabConfig(
  projectRoot: string,
  overrides: Partial<KucLabConfig> = {},
): Promise<string> {
  const configPath = path.join(projectRoot, "kuclab.config.json");
  const config = kuclabConfigSchema.parse(overrides);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}
