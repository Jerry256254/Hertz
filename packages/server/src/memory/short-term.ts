import fs from "node:fs/promises";
import path from "node:path";
import type { HertzPaths } from "../paths.js";
import { agentMemoryDir, agentSessionMemoryDir } from "../paths.js";
import { buildCanvasMermaid, newNodeId, stepLabelFor, type CanvasStep } from "./canvas.js";
import { loadAgentMemoryConfig } from "./config.js";

const STEPS_FILE = "steps.jsonl";
const CANVAS_FILE = "canvas.mmd";
const REFS_DIR = "refs";

/** Tools whose results must never be offloaded (drill-downs would point at drill-downs). */
export const OFFLOAD_EXCLUDED_TOOLS = new Set(["read_memory_ref", "recall_memory", "list_memory", "ask_user"]);

export interface OffloadDecision {
  /** True when the summary was spilled to refs/ and replaced with a pointer. */
  offloaded: boolean;
  summary: string;
  nodeId: string;
}

/**
 * Records one tool execution in the session's short-term memory and offloads
 * heavy outputs: full text → refs/<nodeId>.md, one step → steps.jsonl,
 * canvas.mmd rebuilt. Best-effort — memory must never break a tool call.
 */
export async function recordToolStep(opts: {
  paths: HertzPaths;
  /** The agent's home project (agents.projectId) — canvases live in his home, not the session's project. */
  projectId: string;
  agentId: string;
  sessionId: string;
  sessionTitle?: string;
  tool: string;
  input: unknown;
  summary: string;
  isError?: boolean;
}): Promise<OffloadDecision> {
  const config = loadAgentMemoryConfig();
  const nodeId = newNodeId();
  const dir = agentSessionMemoryDir(opts.paths, opts.projectId, opts.agentId, opts.sessionId);
  const shouldOffload =
    !OFFLOAD_EXCLUDED_TOOLS.has(opts.tool) && opts.summary.length > config.offloadThresholdChars && !opts.isError;

  let summary = opts.summary;
  let resultRef: string | undefined;
  try {
    await fs.mkdir(path.join(dir, REFS_DIR), { recursive: true });
    if (shouldOffload) {
      resultRef = nodeId;
      await fs.writeFile(path.join(dir, REFS_DIR, `${nodeId}.md`), offloadRefBody(opts, nodeId), "utf8");
      const excerpt = opts.summary.slice(0, config.offloadExcerptChars).trimEnd();
      summary = [
        `${excerpt}`,
        "",
        `[Offloaded ${(opts.summary.length / 1024).toFixed(1)} KB — full output kept at ref ${nodeId}. Call read_memory_ref with nodeId "${nodeId}" to retrieve any part of it.]`,
      ].join("\n");
    }
    const step: CanvasStep = {
      nodeId,
      seq: (await countSteps(dir)) + 1,
      tool: opts.tool,
      label: stepLabelFor(opts.tool, opts.input, opts.summary).slice(0, 200),
      ...(resultRef ? { resultRef } : {}),
      ...(opts.isError ? { isError: true } : {}),
      at: new Date().toISOString(),
    };
    await fs.appendFile(path.join(dir, STEPS_FILE), `${JSON.stringify(step)}\n`, "utf8");
    await rebuildCanvas(dir, opts.sessionTitle ?? "session", config.canvasMaxSteps);
  } catch {
    // Fall through with the original summary — recording must be invisible on failure.
    return { offloaded: false, summary: opts.summary, nodeId };
  }
  return { offloaded: shouldOffload, summary, nodeId };
}

function offloadRefBody(opts: { tool: string; input: unknown; summary: string; sessionId: string }, nodeId: string): string {
  let inputJson = "";
  try {
    inputJson = JSON.stringify(opts.input ?? {}, null, 2)?.slice(0, 2000) ?? "";
  } catch {
    inputJson = "";
  }
  return [
    `# Tool ref ${nodeId}`,
    "",
    `- tool: ${opts.tool}`,
    `- session: ${opts.sessionId}`,
    `- captured: ${new Date().toISOString()}`,
    ...(inputJson ? ["", "## Input", "", "```json", inputJson, "```"] : []),
    "",
    "## Full output",
    "",
    opts.summary,
    "",
  ].join("\n");
}

async function countSteps(dir: string): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(dir, STEPS_FILE), "utf8");
    return raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

export async function readSteps(paths: HertzPaths, projectId: string, agentId: string, sessionId: string): Promise<CanvasStep[]> {
  try {
    const raw = await fs.readFile(path.join(agentSessionMemoryDir(paths, projectId, agentId, sessionId), STEPS_FILE), "utf8");
    const out: CanvasStep[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as CanvasStep);
      } catch {
        /* skip corrupt lines */
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

async function rebuildCanvas(dir: string, sessionTitle: string, maxSteps: number): Promise<void> {
  const raw = await fs.readFile(path.join(dir, STEPS_FILE), "utf8").catch(() => "");
  const steps: CanvasStep[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      steps.push(JSON.parse(line) as CanvasStep);
    } catch {
      /* skip */
    }
  }
  steps.sort((a, b) => a.seq - b.seq);
  const tail = steps.slice(Math.max(0, steps.length - Math.max(1, maxSteps)));
  await fs.writeFile(path.join(dir, CANVAS_FILE), buildCanvasMermaid(sessionTitle, tail), "utf8");
}

/** Loads the session canvas for prompt injection (empty string when the session has no steps yet). */
export async function loadCanvas(paths: HertzPaths, projectId: string, agentId: string, sessionId: string): Promise<string> {
  try {
    return await fs.readFile(path.join(agentSessionMemoryDir(paths, projectId, agentId, sessionId), CANVAS_FILE), "utf8");
  } catch {
    return "";
  }
}

/**
 * Drill-down: full text of an offloaded ref. Searches the current session
 * first, then every other session of the same agent (nodeIds are unique per
 * agent, so cross-session recovery just works).
 */
export async function readRef(
  paths: HertzPaths,
  projectId: string,
  agentId: string,
  nodeId: string,
  sessionId?: string,
): Promise<string | undefined> {
  const clean = nodeId.trim().replace(/[^a-zA-Z0-9_]/g, "");
  if (!clean) return undefined;
  const candidates: string[] = [];
  if (sessionId) candidates.push(path.join(agentSessionMemoryDir(paths, projectId, agentId, sessionId), REFS_DIR, `${clean}.md`));
  try {
    const base = path.join(agentMemoryDir(paths, projectId, agentId), "sessions");
    const entries = await fs.readdir(base);
    for (const entry of entries.sort()) {
      if (entry === sessionId) continue;
      candidates.push(path.join(base, entry, REFS_DIR, `${clean}.md`));
    }
  } catch {
    /* no sessions yet */
  }
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch {
      /* try next */
    }
  }
  return undefined;
}
