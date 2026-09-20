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

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

function strEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
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
  /** Vector recall (TencentDB-style): node:sqlite + sqlite-vec sidecar file. */
  vectorDbFileName: string;
  /** OpenAI-compatible embedding model for atom vectors (agent provider's key is reused). */
  embedModel: string;
  embedDimensions: number;
  embedTimeoutMs: number;
  embedMaxInputChars: number;
  /** Include `dimensions` in the embeddings request (disable for BGE-style models). */
  embedSendDimensions: boolean;
  embedBatchSize: number;
  /** Max atoms (re-)embedded per pipeline run — bounds API cost on large backlogs. */
  reindexPerRun: number;
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
    vectorDbFileName: strEnv("HERTZ_MEMORY_VECTOR_DB", "memory-vectors.db"),
    embedModel: strEnv("HERTZ_MEMORY_EMBED_MODEL", "text-embedding-3-small"),
    embedDimensions: numEnv("HERTZ_MEMORY_EMBED_DIMENSIONS", 1536),
    embedTimeoutMs: numEnv("HERTZ_MEMORY_EMBED_TIMEOUT_MS", 15_000),
    embedMaxInputChars: numEnv("HERTZ_MEMORY_EMBED_MAX_CHARS", 5000),
    embedSendDimensions: boolEnv("HERTZ_MEMORY_EMBED_SEND_DIMENSIONS", true),
    embedBatchSize: numEnv("HERTZ_MEMORY_EMBED_BATCH", 20),
    reindexPerRun: numEnv("HERTZ_MEMORY_REINDEX_PER_RUN", 100),
  };
}
