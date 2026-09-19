/**
 * LLM distillation prompts + strict parsers for the L0 → L1 → L2 → L3 pipeline.
 *
 * Pure string builders/parsers (no provider calls) so prompts and their
 * recovery behavior stay unit-tested; memory/pipeline.ts wires them to the
 * agent's own model.
 */

export interface DistilledAtom {
  text: string;
  importance: number;
}

export interface DistilledScenario {
  slug: string;
  title: string;
  summary: string;
  /** 1-based indexes into the atom list given in the prompt. */
  atomIndexes: number[];
}

const JSON_ONLY = "Reply with STRICT JSON only — no markdown fences, no commentary.";

export function buildAtomExtractionPrompt(transcript: string, maxAtoms: number, existingAtoms: string[]): string {
  return [
    "You are a memory curator for an AI agent. Distill durable knowledge from this conversation turn.",
    "",
    "TRANSCRIPT (most recent turns):",
    transcript,
    "",
    existingAtoms.length > 0 ? `ALREADY KNOWN (do NOT repeat these):\n${existingAtoms.map((a) => `- ${a}`).join("\n")}\n` : "",
    `Produce ${JSON_ONLY}`,
    `{"atoms":[{"text":"...","importance":1-5}]}`,
    "",
    `Rules: each atom is ONE self-contained fact (no pronouns pointing outside the sentence); skip greetings, small-talk, and one-off tool noise; importance 5 = always-relevant user preference or identity fact, 3 = useful durable knowledge, 1-2 = minor; at most ${maxAtoms} atoms; empty list [] when nothing is worth keeping.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function buildScenarioClusteringPrompt(atoms: Array<{ index: number; text: string }>, existingScenarios: Array<{ slug: string; title: string }>): string {
  return [
    "You are a memory curator for an AI agent. Cluster its atomic facts into topic scenarios.",
    "",
    "ATOMS:",
    atoms.map((a) => `${a.index}. ${a.text}`).join("\n") || "(none)",
    "",
    existingScenarios.length > 0
      ? `EXISTING SCENARIOS (reuse a slug when the atoms fit it):\n${existingScenarios.map((s) => `- ${s.slug}: ${s.title}`).join("\n")}\n`
      : "",
    `Produce ${JSON_ONLY}`,
    `{"scenarios":[{"slug":"lowercase-dashes","title":"...","summary":"2-4 dense sentences","atomIndexes":[1,2]}]}`,
    "",
    "Rules: slugs are short, lowercase, dash-separated; every atom lands in exactly one scenario; merge near-identical topics; 2-8 scenarios total; summaries carry the durable gist, not the chat narrative.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function buildPersonaPrompt(scenarios: Array<{ title: string; summary: string }>, topAtoms: string[], previousPersona: string): string {
  return [
    "You are a memory curator for an AI agent. Write its living persona profile (L3) — who it serves, what it works on, how it likes to work, lessons learned.",
    "",
    "SCENARIOS:",
    scenarios.map((s) => `- ${s.title}: ${s.summary}`).join("\n") || "(none)",
    "",
    "KEY FACTS:",
    topAtoms.map((a) => `- ${a}`).join("\n") || "(none)",
    "",
    previousPersona ? `PREVIOUS PERSONA (evolve it, don't restart from zero):\n${previousPersona}\n` : "",
    `Produce ${JSON_ONLY}`,
    `{"persona":"..."}`,
    "",
    "Rules: first person, present tense; 4-10 sentences; concrete (names, projects, preferences) over generic; drop stale details that no scenario supports anymore.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Extracts the first {...} object from possibly-chatty model output. */
export function extractJsonObject(raw: string): unknown | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as unknown;
  } catch {
    return undefined;
  }
}

function clampImportance(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(5, Math.max(1, n));
}

export function parseAtomsResponse(raw: string, maxAtoms: number): DistilledAtom[] {
  const parsed = extractJsonObject(raw) as { atoms?: Array<{ text?: unknown; importance?: unknown }> } | undefined;
  if (!parsed || !Array.isArray(parsed.atoms)) return [];
  const out: DistilledAtom[] = [];
  for (const atom of parsed.atoms.slice(0, Math.max(0, maxAtoms))) {
    if (typeof atom?.text !== "string" || !atom.text.trim()) continue;
    out.push({ text: atom.text.trim().slice(0, 500), importance: clampImportance(atom.importance, 2) });
  }
  return out;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

export function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return SLUG_RE.test(slug) ? slug : "";
}

export function parseScenariosResponse(raw: string, atomCount: number): DistilledScenario[] {
  const parsed = extractJsonObject(raw) as {
    scenarios?: Array<{ slug?: unknown; title?: unknown; summary?: unknown; atomIndexes?: unknown }>;
  } | undefined;
  if (!parsed || !Array.isArray(parsed.scenarios)) return [];
  const out: DistilledScenario[] = [];
  for (const scenario of parsed.scenarios.slice(0, 12)) {
    const slug = typeof scenario?.slug === "string" ? slugify(scenario.slug) : "";
    if (!slug) continue;
    const title = typeof scenario?.title === "string" && scenario.title.trim() ? scenario.title.trim().slice(0, 120) : slug;
    const summary = typeof scenario?.summary === "string" && scenario.summary.trim() ? scenario.summary.trim().slice(0, 1500) : "";
    if (!summary) continue;
    const indexes = Array.isArray(scenario?.atomIndexes)
      ? [...new Set(scenario.atomIndexes.filter((i): i is number => Number.isInteger(i) && (i as number) >= 1 && (i as number) <= atomCount))]
      : [];
    if (indexes.length === 0) continue;
    out.push({ slug, title, summary, atomIndexes: indexes });
  }
  return out;
}

export function parsePersonaResponse(raw: string): string {
  const parsed = extractJsonObject(raw) as { persona?: unknown } | undefined;
  if (!parsed || typeof parsed.persona !== "string" || !parsed.persona.trim()) return "";
  return parsed.persona.trim().slice(0, 4000);
}
