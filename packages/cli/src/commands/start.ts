import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import { buildApp, type AppContext } from "@kuclab-hertz/server";
import type { HertzConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveWebDistDir(): string | undefined {
  // packages/cli/dist/commands/start.js -> ../../../web/dist == packages/web/dist
  const candidate = path.resolve(__dirname, "../../../web/dist");
  return fs.existsSync(path.join(candidate, "index.html")) ? candidate : undefined;
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
