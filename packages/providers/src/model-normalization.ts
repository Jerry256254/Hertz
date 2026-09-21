export type ModelResolutionVia = "exact" | "alias" | "default" | "first" | "unverified";

export interface ModelResolution {
  /** The model id that should actually be sent to the provider. */
  model: string;
  /** True when the requested id was replaced by something else. */
  changed: boolean;
  /** How the effective id was picked. */
  via: ModelResolutionVia;
}

/**
 * Known id aliases: a requested id that the endpoint does not serve, mapped to
 * equivalent ids to try instead (order matters — first supported hit wins).
 * This covers providers/gateways that rename models across generations
 * (e.g. DeepSeek's first-party `deepseek-flash` vs the gateway-style
 * `deepseek-v4.1-flash`).
 */
const KNOWN_ALIASES: Record<string, string[]> = {
  "deepseek-v4.1-flash": ["deepseek-flash", "deepseek-v4-flash"],
  "deepseek-v4-flash": ["deepseek-flash", "deepseek-v4.1-flash"],
  "deepseek-flash": ["deepseek-v4.1-flash", "deepseek-v4-flash"],
  "deepseek-v4.1-pro": ["deepseek-v4-pro"],
  "deepseek-v4-pro": ["deepseek-v4.1-pro"],
  "deepseek-chat": ["deepseek-flash", "deepseek-v4.1-flash"],
  "deepseek-reasoner": ["deepseek-v4-pro", "deepseek-v4.1-pro"],
};

/** Matches version infixes like "-v4", "-v4.1", "-V2" so they can be stripped as a fallback. */
const VERSION_INFIX = /-v\d+(?:\.\d+)?/i;

/**
 * Picks the model id to actually send to the provider. Never throws and never
 * blocks: when the supported list is unknown (empty — scan failed), the
 * requested id passes through unchanged with via "unverified".
 *
 * Order: exact match → known alias → version-infix strip → case-insensitive
 * match → configured default → first supported id.
 */
export function resolveSupportedModel(
  requested: string,
  supported: string[],
  defaultModel?: string,
): ModelResolution {
  const want = (requested ?? "").trim();
  if (supported.length === 0 || !want) {
    return { model: requested, changed: false, via: "unverified" };
  }
  const ids = new Set(supported);
  if (ids.has(want)) return { model: want, changed: false, via: "exact" };

  const candidates: string[] = [];
  for (const alias of KNOWN_ALIASES[want] ?? []) candidates.push(alias);
  const stripped = want.replace(VERSION_INFIX, "");
  if (stripped !== want) candidates.push(stripped);
  const lowered = want.toLowerCase();
  const ciHit = supported.find((id) => id.toLowerCase() === lowered);
  if (ciHit) candidates.push(ciHit);

  for (const c of candidates) {
    if (ids.has(c)) return { model: c, changed: true, via: "alias" };
  }
  if (defaultModel && ids.has(defaultModel) && defaultModel !== want) {
    return { model: defaultModel, changed: true, via: "default" };
  }
  const first = supported[0]!;
  if (first !== want) return { model: first, changed: true, via: "first" };
  return { model: want, changed: false, via: "exact" };
}
