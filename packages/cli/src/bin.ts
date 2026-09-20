#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import kleur from "kleur";
import { createAppContext } from "@kuclab-hertz/server";
import { loadConfig } from "./config.js";
import { runNetworkSetup } from "./commands/setup.js";
import { startServer } from "./commands/start.js";
import { runFactoryReset, runPasswd, runUsers, runWipeMemory } from "./commands/admin.js";

function checkNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.error(kleur.red(`KucLab Hertz requires Node.js >= 22 (found ${process.version}).`));
    process.exit(1);
  }
}

/** `hzcli update` — same logic as the WebUI button: pull, build, restart service. */
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

function printHelp(): void {
  console.log(`
${kleur.bold("hzcli")} — self-hosted autonomous agent platform

  ${kleur.cyan("hzcli start")}                    start the server + WebUI
  ${kleur.cyan("hzcli setup")}                    network setup (host/port wizard)
  ${kleur.cyan("hzcli update")}                   pull, rebuild, restart (data preserved)
  ${kleur.cyan("hzcli users")}                    list user accounts
  ${kleur.cyan("hzcli passwd [email]")}           reset a user's password (recovery, no current password needed)
  ${kleur.cyan("hzcli wipe-memory --all")}        completely erase every agent's memory
  ${kleur.cyan("hzcli wipe-memory --agent <id>")} completely erase one agent's memory
  ${kleur.cyan("hzcli factory-reset")}            delete EVERYTHING back to first-install state
  ${kleur.cyan("hzcli help")}                     this help

Admin commands work directly on the data dir (${kleur.dim(process.env.HERTZ_DATA_DIR ?? "~/.kuclab-hertz")})
and never boot the server — safe to run while it is stopped.
`);
}

async function main(): Promise<void> {
  checkNodeVersion();

  const command = process.argv[2];
  if (command === "update") {
    runUpdate();
    return;
  }

  // Headless admin commands — direct data-dir access, no server boot, so they
  // work while stopped or when locked out of the WebUI.
  if (command === "users") {
    await runUsers();
    return;
  }
  if (command === "passwd") {
    await runPasswd(process.argv.slice(3));
    return;
  }
  if (command === "wipe-memory") {
    await runWipeMemory(process.argv.slice(3));
    return;
  }
  if (command === "factory-reset") {
    await runFactoryReset(process.argv.slice(3));
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
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
          "No network config found. Run `hzcli setup` first (from a source checkout: `pnpm setup`).",
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
