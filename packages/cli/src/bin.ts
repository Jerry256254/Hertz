#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

/** `hertz update` — same logic as the WebUI button: pull, build, restart service. */
function runUpdate(): void {
  const candidates = [
    path.resolve(process.cwd(), "scripts", "update.sh"),
    path.resolve(__dirname, "../../scripts/update.sh"),
    path.resolve(__dirname, "../../../scripts/update.sh"),
  ];
  const script = candidates.find((c) => fs.existsSync(c));
  if (!script) {
    console.error(kleur.red("update.sh not found — run this from a Hertz checkout (or reinstall via install.sh)."));
    process.exit(1);
  }
  console.log(kleur.bold("Updating Hertz (data is preserved)...\n"));
  const child = spawn("bash", [script], { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 1));
}

async function main(): Promise<void> {
  checkNodeVersion();

  const command = process.argv[2];
  if (command === "update") {
    runUpdate();
    return;
  }

  const ctx = await createAppContext(process.env.HERTZ_DATA_DIR);

  if (command === "setup") {
    await runNetworkSetup(ctx);
    return;
  }

  let config = await loadConfig(ctx.paths);
  if (!config) {
    if (command === "start") {
      console.error(
        kleur.red(
          "No network config found. Run `hertz setup` first (from a source checkout: `pnpm setup`).",
        ),
      );
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
