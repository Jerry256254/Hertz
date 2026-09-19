import crypto from "node:crypto";

/**
 * Short-term symbolic memory: a Mermaid task canvas per session.
 *
 * Heavy tool outputs are offloaded to refs/<nodeId>.md; the history keeps only
 * a compact pointer. The canvas maps the session's state transitions in
 * high-density Mermaid syntax (LLM-parseable, human-readable); every node with
 * offloaded output links back to its ref via node_id, so nothing is
 * irreversibly compressed: canvas → steps.jsonl → refs/*.md.
 */

export interface CanvasStep {
  /** Stable drill-down handle, e.g. "n3f9a2". */
  nodeId: string;
  /** Sequence number within the session (1-based). */
  seq: number;
  tool: string;
  /** One-line human summary of what this step did. */
  label: string;
  /** Set when the full output was offloaded to refs/<nodeId>.md. */
  resultRef?: string;
  isError?: boolean;
  at: string;
}

export function newNodeId(): string {
  return `n${crypto.randomBytes(3).toString("hex")}`;
}

/** Mermaid labels break on quotes/brackets — escape aggressively, keep readable. */
export function escapeMermaidLabel(label: string, maxLen = 80): string {
  const flat = label.replace(/\s+/g, " ").trim();
  const cut = flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat;
  return cut.replace(/["#<>`]/g, "").replace(/[{()}[\]]/g, "");
}

/**
 * Builds the Mermaid canvas for a session's steps (already ordered by seq).
 * Offloaded nodes get a distinct shape (stadium) + result_ref annotation so
 * the agent can see at a glance which steps carry retrievable detail.
 */
export function buildCanvasMermaid(sessionTitle: string, steps: CanvasStep[]): string {
  const lines = ["graph LR"];
  if (steps.length === 0) {
    lines.push('    start(["Session started"])');
    return `${lines.join("\n")}\n`;
  }
  const title = escapeMermaidLabel(sessionTitle || "session", 40);
  lines.push(`    start(["${title}"])`);
  let prev = "start";
  for (const step of steps) {
    const id = step.nodeId.replace(/[^a-zA-Z0-9_]/g, "");
    const label = escapeMermaidLabel(`${step.seq}. ${step.tool}: ${step.label}`);
    if (step.resultRef) {
      lines.push(`    ${id}(["${label}<br/>ref: ${step.resultRef}"])`);
    } else if (step.isError) {
      lines.push(`    ${id}{{"${label} ❌"}}`);
    } else {
      lines.push(`    ${id}["${label}"]`);
    }
    lines.push(`    ${prev} --> ${id}`);
    prev = id;
  }
  return `${lines.join("\n")}\n`;
}

/** One-line step label derived from a tool call (truncated input hint). */
export function stepLabelFor(tool: string, input: unknown, summary: string): string {
  const hint = summarizeToolInput(input);
  const outcome = summary.replace(/\s+/g, " ").trim().slice(0, 60);
  return hint ? `${hint} → ${outcome}` : outcome || "(no output)";
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const pick = (keys: string[]): string => {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 60);
    }
    return "";
  };
  // Most-addressed-first across the Hertz toolset (paths, commands, urls, queries).
  return pick(["path", "command", "url", "query", "question", "note", "filename", "name", "pattern"]);
}
