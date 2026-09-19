/**
 * Layered agent memory (L0 → L3 + short-term symbols) — tunables.
 *
 * Every value has a working default; operators override via HERTZ_MEMORY_*
 * env vars. Kept in one place so the pipeline, recall, and offload hook
 * can't drift apart on thresholds.
 */

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface AgentMemoryConfig {
  /** L0 → L1: distill atoms every N new conversation turns (user+assistant pair = 1). */
  extractEveryNTurns: number;
  /** Max atoms distilled from one extraction pass. */
  maxAtomsPerPass: number;
  /** L1 → L2: re-cluster scenarios every N new unclustered atoms. */
  clusterEveryNAtoms: number;
  /** L2 → L3: refresh persona.md every N new atoms (and at most once per minPersonaIntervalMs). */
  personaEveryNAtoms: number;
  minPersonaIntervalMs: number;
  /** Prompt-injection budgets (progressive disclosure: persona always, scenarios + atoms ranked). */
  promptMaxScenarios: number;
  promptMaxAtoms: number;
  promptMaxPersonaChars: number;
  /** Recall tool budgets. */
  recallMaxResults: number;
  recallMaxCharsPerItem: number;
  /** Short-term offload: tool results longer than this spill to refs/*.md with a node_id pointer. */
  offloadThresholdChars: number;
  /** Excerpt of an offloaded result kept inline in the history. */
  offloadExcerptChars: number;
  /** Canvas keeps the last N steps; older ones stay in steps.jsonl + refs. */
  canvasMaxSteps: number;
}

export function loadAgentMemoryConfig(): AgentMemoryConfig {
  return {
    extractEveryNTurns: numEnv("HERTZ_MEMORY_EXTRACT_EVERY_N_TURNS", 5),
    maxAtomsPerPass: numEnv("HERTZ_MEMORY_MAX_ATOMS_PER_PASS", 20),
    clusterEveryNAtoms: numEnv("HERTZ_MEMORY_CLUSTER_EVERY_N_ATOMS", 20),
    personaEveryNAtoms: numEnv("HERTZ_MEMORY_PERSONA_EVERY_N_ATOMS", 25),
    minPersonaIntervalMs: numEnv("HERTZ_MEMORY_MIN_PERSONA_INTERVAL_MS", 3_600_000),
    promptMaxScenarios: numEnv("HERTZ_MEMORY_PROMPT_MAX_SCENARIOS", 6),
    promptMaxAtoms: numEnv("HERTZ_MEMORY_PROMPT_MAX_ATOMS", 20),
    promptMaxPersonaChars: numEnv("HERTZ_MEMORY_PROMPT_MAX_PERSONA_CHARS", 1200),
    recallMaxResults: numEnv("HERTZ_MEMORY_RECALL_MAX_RESULTS", 8),
    recallMaxCharsPerItem: numEnv("HERTZ_MEMORY_RECALL_MAX_CHARS", 800),
    offloadThresholdChars: numEnv("HERTZ_MEMORY_OFFLOAD_THRESHOLD_CHARS", 6000),
    offloadExcerptChars: numEnv("HERTZ_MEMORY_OFFLOAD_EXCERPT_CHARS", 2000),
    canvasMaxSteps: numEnv("HERTZ_MEMORY_CANVAS_MAX_STEPS", 40),
  };
}
