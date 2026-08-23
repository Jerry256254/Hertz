import prompts from "prompts";
import kleur from "kleur";
import type { AppContext } from "@kuclab-hertz/server";
import { saveConfig, DEFAULT_HOST, type HertzConfig } from "../config.js";

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
  console.log(kleur.dim("Where should the WebUI be reachable from?\n"));

  const { bindChoice } = await prompts(
    {
      type: "select",
      name: "bindChoice",
      message: "Network binding",
      choices: [
        {
          title: "All interfaces (0.0.0.0) — reachable from other machines: LAN, Tailscale, VPN",
          value: "0.0.0.0",
        },
        {
          title: "This machine only (127.0.0.1) — pick ONLY if you browse on this same computer",
          value: "127.0.0.1",
        },
      ],
      initial: 0,
    },
    { onCancel },
  );
  if (bindChoice === "0.0.0.0") {
    console.log(
      kleur.yellow(
        "\nNote: the WebUI will be reachable from your network. Protect it with strong passwords,\n" +
          "a firewall allowing only what you need, or keep access limited to your Tailscale network.\n",
      ),
    );
  }

  const { port } = await prompts(
    { type: "number", name: "port", message: "Port", initial: 4173 },
    { onCancel },
  );

  const config: HertzConfig = { host: bindChoice ?? DEFAULT_HOST, port: port ?? 4173 };
  await saveConfig(ctx.paths, config);

  console.log(kleur.green(`\n✓ Network setup complete. Server will use http://${config.host}:${config.port}`));
  console.log(kleur.dim("  Start it with `pnpm start` (from a source checkout), then open the address above in a browser.\n"));

  return config;
}
