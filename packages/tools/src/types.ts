import type { z } from "zod";
import type { ActorContext, AuditSink, PathGuard } from "@kuclab-hertz/sandbox";
import type { ShellPolicy } from "@kuclab-hertz/sandbox";

export interface ArtifactStore {
  /** Persists large tool output out-of-band and returns a fetchable id (not resent to the model). */
  store(sessionId: string, content: string): Promise<string>;
  get(sessionId: string, artifactId: string): Promise<string | undefined>;
}

/**
 * The agent's "own computer" — when an agent runs in an isolated backend
 * (a Docker container), shell commands execute THERE instead of on the host.
 * Paths are identical on both sides because project/employee directories are
 * bind-mounted at their host-absolute locations, so the PathGuard-resolved cwd
 * is valid inside the container unchanged.
 */
export interface ComputerRuntime {
  exec(input: { command: string; args: string[]; cwd: string; timeoutMs?: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
  }>;
}

/** Drives the persistent Playwright daemon inside the agent's container. */
export interface BrowserController {
  act(action: string, params?: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

export interface ToolContext {
  actor: ActorContext;
  rootId: string;
  pathGuard: PathGuard;
  shellPolicy: ShellPolicy;
  audit: AuditSink;
  artifacts: ArtifactStore;
  /** Present when the agent works inside its own container — shell tools route there. */
  computer?: ComputerRuntime;
  /** Present when the agent has a browser daemon available (docker backend). */
  browser?: BrowserController;
}

export interface ToolResult {
  /** What actually gets sent back to the model — kept minimal and structured, not a raw dump. */
  summary: string;
  artifactId?: string;
  isError?: boolean;
  /**
   * Set by tools that park the run until the human decides (e.g.
   * request_approval). The loop stores the question on the session, flips it
   * to awaiting_input, and a later decision/answer resumes the run. Works in
   * autonomous mode too — that's the point of a human-in-the-loop gate.
   */
  awaitUser?: { question: string };
}

export interface ToolDef<TInput = any> {
  name: string;
  description: string;
  /** Third generic left open so schemas built with z.default()/.optional() (whose parsed _input differs from output) still satisfy this. */
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, any>;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
