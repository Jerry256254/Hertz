import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import kleur from "kleur";
import { buildApp, type AppContext } from "@kuclab-hertz/server";
import type { HertzConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function resolveWebDistDir(): string | undefined {
  // In the monorepo: packages/cli/dist/commands/start.js -> ../../../web/dist
  const local = path.resolve(__dirname, "../../../web/dist");
  if (fs.existsSync(path.join(local, "index.html"))) return local;
  // When installed from npm: node_modules/@kuclab-hertz/web/dist/index.html
  try {
    const entry = require.resolve("@kuclab-hertz/web/package.json");
    const installed = path.join(path.dirname(entry), "dist");
    if (fs.existsSync(path.join(installed, "index.html"))) return installed;
  } catch {
    // not installed as a package — fall through
  }
  return undefined;
}

export async function startServer(ctx: AppContext, config: HertzConfig): Promise<void> {
  const webDistDir = resolveWebDistDir();
  if (!webDistDir) {
    console.log(kleur.yellow("No built WebUI found — running API-only. Run `pnpm --filter @kuclab-hertz/web build` first."));
  }

  const app = await buildApp(ctx, { webDistDir });
  await app.listen({ host: config.host, port: config.port });

  console.log(kleur.bold(kleur.green(`\nKucLab Hertz is running at http://${config.host}:${config.port}\n`)));
}
