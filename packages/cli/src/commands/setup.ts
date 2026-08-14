import prompts from "prompts";
import kleur from "kleur";
import type { AppContext } from "@kuclab-hertz/server";
import { saveConfig, type HertzConfig } from "../config.js";

function onCancel(): never {
  console.log(kleur.red("\nSetup cancelled."));
  process.exit(1);
}

/**
 * The only thing that has to happen at the terminal: choosing what interface the
 * server binds to, since that decides what can even reach it before a browser is
 * in the picture. Admin account creation and provider setup happen in the WebUI's
 * first-run flow (see routes/setup.ts + web/src/routes/SetupPage.tsx) — bootstrap
 * config a human fills in once via a form beats a sequence of terminal prompts.
 */
export async function runNetworkSetup(ctx: AppContext): Promise<HertzConfig> {
  console.log(kleur.bold("\nKucLab Hertz — network setup\n"));

  const { bindChoice } = await prompts(
    {
      type: "select",
      name: "bindChoice",
      message: "Network binding",
      choices: [
        { title: "Localhost only (recommended)", value: "127.0.0.1" },
        { title: "All interfaces — requires HTTPS/Tailscale, see warning", value: "0.0.0.0" },
      ],
    },
    { onCancel },
  );
  if (bindChoice === "0.0.0.0") {
    console.log(
      kleur.yellow(
        "\nWarning: binding to all interfaces exposes the WebUI (and your provider keys' blast radius) to your network.\n" +
          "Put this behind HTTPS, or prefer Tailscale and keep this on 127.0.0.1 instead.\n",
      ),
    );
  }

  const { port } = await prompts(
    { type: "number", name: "port", message: "Port", initial: 4173 },
    { onCancel },
  );

  const config: HertzConfig = { host: bindChoice, port: port ?? 4173 };
  await saveConfig(ctx.paths, config);

  console.log(kleur.green(`\n✓ Network setup complete. Starting server on http://${config.host}:${config.port} ...`));
  console.log(kleur.dim("  Create your admin account and add a provider from the WebUI once it's open.\n"));

  return config;
}
