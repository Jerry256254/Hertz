#!/usr/bin/env node
import kleur from "kleur";
import { createAppContext } from "@kuclab-hertz/server";
import { loadConfig } from "./config.js";
import { runNetworkSetup } from "./commands/setup.js";
import { startServer } from "./commands/start.js";

function checkNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.error(kleur.red(`KucLab Hertz requires Node.js >= 20 (found ${process.version}).`));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  checkNodeVersion();

  const command = process.argv[2];
  const ctx = await createAppContext(process.env.HERTZ_DATA_DIR);

  if (command === "setup") {
    await runNetworkSetup(ctx);
    return;
  }

  let config = await loadConfig(ctx.paths);
  if (!config) {
    if (command === "start") {
      console.error(kleur.red("No network config found. Run `kuclab-hertz setup` first."));
      process.exit(1);
    }
    config = await runNetworkSetup(ctx);
  }

  await startServer(ctx, config);
}

main().catch((err) => {
  console.error(kleur.red(`\nFatal error: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
