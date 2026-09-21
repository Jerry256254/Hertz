import { eq } from "drizzle-orm";
import type { ModelInfo } from "@kuclab-hertz/providers";
import { resolveSupportedModel } from "@kuclab-hertz/providers";
import type { ProviderPort } from "@kuclab-hertz/core";
import type { Database } from "../db/client.js";
import { agents, providerConfigs } from "../db/schema.js";

export interface ModelResolverDeps {
  db: Database;
  providers: ProviderPort;
}

/** Per providerConfigId → scanned model list; providers are asked at most once a minute. */
const modelListCache = new Map<string, { at: number; models: ModelInfo[] }>();

export function clearModelListCache(): void {
  modelListCache.clear();
}

export async function scannedModels(deps: ModelResolverDeps, providerConfigId: string): Promise<ModelInfo[]> {
  const cached = modelListCache.get(providerConfigId);
  if (cached && Date.now() - cached.at < 60_000) return cached.models;
  const adapter = await deps.providers.getAdapter(providerConfigId);
  const models = await adapter.listModels();
  modelListCache.set(providerConfigId, { at: Date.now(), models });
  return models;
}

/**
 * A stale stored model id (renamed or retired by the provider, or typed by
 * hand) would otherwise fail only at stream time with a cryptic provider
 * error. Validate against the live /models scan before the run: when the
 * stored id is no longer offered, first try a known id alias, then fall back
 * to the provider's default model (or the first scanned one), and persist the
 * correction so the UI shows it. A scan failure never blocks the run — the
 * stored id is used as-is.
 */
export async function resolveEffectiveModel(
  deps: ModelResolverDeps,
  agent: typeof agents.$inferSelect,
): Promise<string> {
  let models: ModelInfo[];
  try {
    models = await scannedModels(deps, agent.providerConfigId);
  } catch {
    return agent.model;
  }
  if (models.some((m) => m.id === agent.model)) return agent.model;
  // Known id aliases (e.g. "deepseek-v4.1-flash" on an endpoint that only
  // serves "deepseek-flash") are mapped before falling back to the default.
  const aliased = resolveSupportedModel(
    agent.model,
    models.map((m) => m.id),
  );
  if (aliased.via === "alias") {
    await deps.db.update(agents).set({ model: aliased.model }).where(eq(agents.id, agent.id));
    agent.model = aliased.model;
    return aliased.model;
  }
  const cfgRows = await deps.db
    .select({ defaultModel: providerConfigs.defaultModel })
    .from(providerConfigs)
    .where(eq(providerConfigs.id, agent.providerConfigId))
    .limit(1);
  const defaultModel = cfgRows[0]?.defaultModel;
  const fallback =
    (defaultModel && models.some((m) => m.id === defaultModel) ? defaultModel : undefined) ?? models[0]?.id;
  if (!fallback || fallback === agent.model) return agent.model;
  await deps.db.update(agents).set({ model: fallback }).where(eq(agents.id, agent.id));
  agent.model = fallback;
  return fallback;
}
