#!/usr/bin/env node
import kleur from "kleur";
import { createAppContext, hasAnyUser } from "@kuclab-hertz/server";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";
import { runSetupWizard } from "./commands/setup.js";
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
    await runSetupWizard(ctx);
    return;
  }

  const needsSetup = !(await hasAnyUser(ctx));

  if (command === "start" && needsSetup) {
    console.error(kleur.red("No admin user found. Run `kuclab-hertz setup` first."));
    process.exit(1);
  }

  if (needsSetup) {
    await runSetupWizard(ctx);
  }

  const config = (await loadConfig(ctx.paths)) ?? DEFAULT_CONFIG;
  await startServer(ctx, config);
}

main().catch((err) => {
  console.error(kleur.red(`\nFatal error: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
