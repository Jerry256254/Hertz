import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import prompts from "prompts";
import kleur from "kleur";
import {
  listAgents,
  listUsers,
  openDatabase,
  resetUserPassword,
  resolveHertzPaths,
  wipeAgentMemory,
  wipeDataDirNow,
  type HertzPaths,
} from "@kuclab-hertz/server";
import { loadConfig } from "../config.js";

function onCancel(): never {
  console.log(kleur.red("\nCancelled."));
  process.exit(1);
}

function fail(message: string): never {
  console.error(kleur.red(message));
  process.exit(1);
}

/** Any HTTP response (even an error page) proves the server is up; refused/timeout means it's down. */
async function isServerRunning(paths: HertzPaths): Promise<boolean> {
  const config = (await loadConfig(paths)) ?? { host: "127.0.0.1", port: 4173 };
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    await fetch(`http://${host}:${config.port}/`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function openDb(paths: HertzPaths) {
  try {
    await fs.access(paths.dbPath);
  } catch {
    fail("No Hertz database yet — run the server once and complete the WebUI setup first.");
  }
  try {
    return openDatabase(paths.dbPath);
  } catch (err) {
    fail(`Cannot open database at ${paths.dbPath}: ${(err as Error).message}`);
  }
}

function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}

function flagValue(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (names.includes(args[i]!)) return args[i + 1];
  }
  return undefined;
}

export async function runUsers(): Promise<void> {
  const paths = resolveHertzPaths(process.env.HERTZ_DATA_DIR);
  const { db } = await openDb(paths);
  let users;
  try {
    users = await listUsers(db);
  } catch {
    fail("No Hertz database yet — run the server once and complete the WebUI setup first.");
  }
  if (users.length === 0) {
    console.log("No users yet — complete the first-run setup in the WebUI.");
    return;
  }
  console.log(kleur.bold(`\nUsers (${users.length}):\n`));
  for (const u of users) {
    console.log(`  ${kleur.cyan(u.email)}  ${kleur.dim(`[${u.role}]`)}`);
  }
  console.log();
}

/**
 * `hzcli passwd [email]` — recovery password reset. Anyone with terminal
 * access to this machine owns the install anyway, so no current password is
 * asked; web sessions are killed so a stale login can't linger.
 */
export async function runPasswd(args: string[]): Promise<void> {
  const paths = resolveHertzPaths(process.env.HERTZ_DATA_DIR);
  const { db } = await openDb(paths);
  let users;
  try {
    users = await listUsers(db);
  } catch {
    fail("No Hertz database yet — run the server once and complete the WebUI setup first.");
  }
  if (users.length === 0) fail("No users yet — complete the first-run setup in the WebUI first.");

  const emailArg = args.find((a) => !a.startsWith("-"));
  let user = emailArg ? users.find((u) => u.email === emailArg) : undefined;
  if (emailArg && !user) {
    fail(`No user with email "${emailArg}". Run \`hzcli users\` to list accounts.`);
  }
  if (!user) {
    if (users.length === 1) {
      user = users[0]!;
    } else {
      console.log("Multiple users exist — specify which one:\n");
      for (const u of users) console.log(`  ${kleur.cyan(u.email)}`);
      console.log();
      fail("Usage: hzcli passwd <email>");
    }
  }

  const { password } = await prompts(
    {
      type: "password",
      name: "password",
      message: `New password for ${user.email} (min 8 characters)`,
      validate: (v: string) => (v.length >= 8 ? true : "Password must be at least 8 characters"),
    },
    { onCancel },
  );
  const { confirm } = await prompts(
    {
      type: "password",
      name: "confirm",
      message: "Repeat the new password",
      validate: (v: string) => (v === password ? true : "Passwords do not match"),
    },
    { onCancel },
  );
  if (!password || password !== confirm) fail("Passwords do not match.");

  await resetUserPassword(db, user.id, password);
  console.log(kleur.green(`\n✓ Password for ${user.email} changed. Their web sessions were signed out.\n`));
}

export function printWipeMemoryHelp(): void {
  console.log(`
${kleur.bold("hzcli wipe-memory")} — completely erase agent memory

  ${kleur.cyan("hzcli wipe-memory --all")}              wipe every agent's memory
  ${kleur.cyan("hzcli wipe-memory --agent <id|name>")}  wipe one agent's memory

Removes L1 atoms, L2 scenarios, legacy notes, persona.md, session canvases
(refs/steps) and state.json. Skills survive unless ${kleur.cyan("--with-skills")} is given.
Flags: ${kleur.cyan("--with-skills")}, ${kleur.cyan("--yes")} / ${kleur.cyan("-y")} (skip confirmation)
`);
}

/** `hzcli wipe-memory --all | --agent <id|name>` — total memory erasure. */
export async function runWipeMemory(args: string[]): Promise<void> {
  if (hasFlag(args, "--help", "-h") || args.length === 0) {
    printWipeMemoryHelp();
    return;
  }
  const paths = resolveHertzPaths(process.env.HERTZ_DATA_DIR);
  const { db } = await openDb(paths);
  let agents;
  try {
    agents = await listAgents(db);
  } catch {
    fail("No Hertz database yet — nothing to wipe.");
  }
  if (agents.length === 0) fail("No agents exist — nothing to wipe.");

  const wipeAll = hasFlag(args, "--all");
  const agentRef = flagValue(args, "--agent");
  if (!wipeAll && !agentRef) {
    printWipeMemoryHelp();
    fail("Specify --all or --agent <id|name>.");
  }
  if (wipeAll && agentRef) fail("Use either --all or --agent, not both.");

  let targets = agents;
  if (agentRef) {
    const byId = agents.filter((a) => a.id === agentRef);
    const byName = agents.filter((a) => a.name === agentRef);
    targets = byId.length > 0 ? byId : byName;
    if (targets.length === 0) fail(`No agent with id or name "${agentRef}".`);
    if (targets.length > 1) {
      fail(`Multiple agents named "${agentRef}" — use the id instead:\n${targets.map((t) => `  ${t.id}`).join("\n")}`);
    }
  }

  const withSkills = hasFlag(args, "--with-skills");
  console.log(kleur.bold(`\nThis will COMPLETELY erase memory of ${targets.length} agent(s):`));
  for (const t of targets) console.log(`  ${kleur.cyan(t.name)} ${kleur.dim(`(${t.id})`)}`);
  console.log(kleur.dim(`  (atoms, scenarios, persona, canvases, refs${withSkills ? ", skills" : ""} — skills ${withSkills ? "included" : "kept"})`));

  if (!hasFlag(args, "--yes", "-y")) {
    const { confirm } = await prompts(
      { type: "confirm", name: "confirm", message: "Erase all of it? This cannot be undone.", initial: false },
      { onCancel },
    );
    if (!confirm) fail("Aborted — memory untouched.");
  }

  if (await isServerRunning(paths)) {
    console.log(kleur.yellow("Note: the server is running — active runs may write new notes right after the wipe."));
  }
  for (const t of targets) {
    const stats = await wipeAgentMemory(db, paths, t.id, { withSkills });
    console.log(
      kleur.green(`✓ ${t.name}:`) +
        ` ${stats.atoms} atoms, ${stats.scenarios} scenarios, ${stats.legacyNotes} legacy notes, memory files erased${withSkills ? " (skills included)" : ""}.`,
    );
  }
  console.log();
}

/** Best-effort removal of this install's agent containers (same filter as the WebUI reset). */
async function removeAgentContainers(): Promise<void> {
  const cleanup = spawn("bash", ["-lc", "docker ps -aq --filter label=kuclab-hertz.managed=true | xargs -r docker rm -f"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => {
    // Kill on timeout — a lingering child handle would keep the CLI alive.
    const timer = setTimeout(() => {
      cleanup.kill("SIGKILL");
      resolve();
    }, 5_000);
    cleanup.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    cleanup.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * `hzcli factory-reset` — back to a pristine first-install state. When the
 * server is running it can't wipe under itself, so the reset is staged via
 * reset.flag (consumed on next boot, like the WebUI button); when stopped,
 * the data dir is wiped immediately.
 */
export async function runFactoryReset(args: string[]): Promise<void> {
  const paths = resolveHertzPaths(process.env.HERTZ_DATA_DIR);

  console.log(kleur.red(kleur.bold("\nThis will DELETE EVERYTHING Hertz owns:")));
  console.log("  database (users, chats, projects, agents), all memory, skills,");
  console.log("  provider keys, containers, config — a fresh install state.");
  if (!hasFlag(args, "--yes", "-y")) {
    const { confirm } = await prompts(
      { type: "text", name: "confirm", message: 'Type RESET to confirm (anything else aborts)' },
      { onCancel },
    );
    if (confirm !== "RESET") fail("Aborted — data untouched.");
  }

  await removeAgentContainers();

  if (await isServerRunning(paths)) {
    await fs.mkdir(paths.dataDir, { recursive: true });
    await fs.writeFile(path.join(paths.dataDir, "reset.flag"), "terminal factory-reset");
    console.log(
      kleur.green("\n✓ Reset staged.") +
        " The server is running, so it will wipe on next boot.\n" +
        `  Restart it now: ${kleur.cyan("sudo systemctl restart hertz")} (or restart the terminal process).\n`,
    );
    return;
  }

  const removed = await wipeDataDirNow(paths);
  if (removed.length === 0) {
    console.log(kleur.dim("\nData directory is already empty — nothing to reset.\n"));
    return;
  }
  console.log(kleur.green(`\n✓ Factory reset complete — removed ${removed.length} item(s) from ${paths.dataDir}.\n`));
}
