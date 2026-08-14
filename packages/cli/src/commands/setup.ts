import prompts from "prompts";
import kleur from "kleur";
import { SUPPORTED_PROVIDERS, createProviderAdapter, type SupportedProvider } from "@kuclab-hertz/providers";
import { createUser, addProviderConfig, type AppContext } from "@kuclab-hertz/server";
import { saveConfig, type HertzConfig } from "../config.js";

function onCancel(): never {
  console.log(kleur.red("\nSetup cancelled."));
  process.exit(1);
}

async function collectOneProvider(): Promise<{
  provider: SupportedProvider;
  label: string;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}> {
  const { provider } = await prompts(
    {
      type: "select",
      name: "provider",
      message: "Provider",
      choices: SUPPORTED_PROVIDERS.map((p) => ({ title: p, value: p })),
    },
    { onCancel },
  );

  const { label, apiKey, baseUrl } = await prompts(
    [
      { type: "text", name: "label", message: "Label for this provider", initial: provider },
      { type: "password", name: "apiKey", message: "API key" },
      {
        type: provider === "openai-compatible" ? "text" : null,
        name: "baseUrl",
        message: "Base URL (e.g. http://localhost:11434/v1)",
      },
    ],
    { onCancel },
  );

  console.log(kleur.dim("Scanning available models..."));
  let defaultModel: string | undefined;
  try {
    const adapter = createProviderAdapter(provider, { apiKey, baseUrl });
    const models = await adapter.listModels();
    if (models.length > 0) {
      const { model } = await prompts(
        {
          type: "select",
          name: "model",
          message: `Default model for ${label}`,
          choices: models.map((m) => ({ title: m.displayName, value: m.id })),
        },
        { onCancel },
      );
      defaultModel = model;
      console.log(kleur.green(`✓ Found ${models.length} model(s).`));
    } else {
      console.log(kleur.yellow("No models returned — you can pick one later in the WebUI."));
    }
  } catch (err) {
    console.log(kleur.yellow(`Could not scan models yet (${(err as Error).message}) — you can retry from the WebUI.`));
  }

  return { provider, label, apiKey, baseUrl, defaultModel };
}

export async function runSetupWizard(ctx: AppContext): Promise<void> {
  console.log(kleur.bold("\nKucLab Hertz — first-time setup\n"));

  const { email, password } = await prompts(
    [
      { type: "text", name: "email", message: "Admin email" },
      { type: "password", name: "password", message: "Admin password (min 8 characters)" },
    ],
    { onCancel },
  );
  if (!email || !password || password.length < 8) {
    console.log(kleur.red("Email and an 8+ character password are required."));
    process.exit(1);
  }

  const providers = [];
  for (;;) {
    providers.push(await collectOneProvider());
    const { again } = await prompts(
      { type: "confirm", name: "again", message: "Add another provider?", initial: false },
      { onCancel },
    );
    if (!again) break;
  }

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

  const userId = await createUser(ctx, email, password, "admin");
  for (const p of providers) {
    await addProviderConfig(ctx, userId, p);
  }

  console.log(kleur.green(`\n✓ Setup complete. Starting server on http://${config.host}:${config.port} ...\n`));
}
