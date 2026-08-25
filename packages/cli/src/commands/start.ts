import fs from "node:fs";
import os from "node:os";
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

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return host.startsWith("127.");
}

/** Non-internal IPv4 addresses of this machine — candidates other devices can reach. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return [...new Set(out)];
}

export async function startServer(ctx: AppContext, config: HertzConfig): Promise<void> {
  // Tools (take-over links) read the public port from the environment.
  process.env.HERTZ_PORT = String(config.port);
  const webDistDir = resolveWebDistDir();
  if (!webDistDir) {
    console.log(kleur.yellow("No built WebUI found — running API-only. Run `pnpm --filter @kuclab-hertz/web build` first."));
  }

  const app = await buildApp(ctx, { webDistDir });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err: any) {
    if (err && (err.code === "EADDRINUSE" || String(err.message).includes("EADDRINUSE"))) {
      console.error(kleur.red(`\nPort ${config.port} is already in use (address ${config.host}:${config.port} busy).`));
      console.error(`Another Hertz (or other process) is still running.`);
      console.error(`  pkill -f 'packages/cli/dist/bin.js start'`);
      console.error(`  fuser -k ${config.port}/tcp   # or: lsof -i :${config.port}`);
      console.error(`Or set a different port:  HERTZ_PORT=4174 node packages/cli/dist/bin.js start\n`);
      process.exit(1);
    }
    throw err;
  }

  console.log(kleur.bold(kleur.green(`\nKucLab Hertz is running at http://${config.host}:${config.port}\n`)));

  if (isLoopback(config.host)) {
    console.log(
      kleur.yellow(
        "⚠ This server listens on 127.0.0.1 only — it is NOT reachable from other machines\n" +
          "  (LAN, Tailscale, VPN). If you browse from this same computer, you're fine.\n" +
          "  To allow remote access, run the setup again (`pnpm setup` or `pnpm hertz setup`)\n" +
          '  and choose "All interfaces", or set "host": "0.0.0.0" in ~/.kuclab-hertz/config.json,\n' +
          "  then restart the server.\n",
      ),
    );
  } else {
    const addresses = lanAddresses();
    if (addresses.length > 0) {
      console.log("Reachable from other machines on:");
      for (const address of addresses) {
        console.log(`  → http://${address}:${config.port}`);
      }
      console.log("");
    }
  }
}
