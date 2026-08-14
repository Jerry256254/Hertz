import type { z } from "zod";
import type { ActorContext, AuditSink, PathGuard } from "@kuclab-hertz/sandbox";
import type { ShellPolicy } from "@kuclab-hertz/sandbox";

export interface ArtifactStore {
  /** Persists large tool output out-of-band and returns a fetchable id (not resent to the model). */
  store(sessionId: string, content: string): Promise<string>;
  get(sessionId: string, artifactId: string): Promise<string | undefined>;
}

export interface ToolContext {
  actor: ActorContext;
  rootId: string;
  pathGuard: PathGuard;
  shellPolicy: ShellPolicy;
  audit: AuditSink;
  artifacts: ArtifactStore;
}

export interface ToolResult {
  /** What actually gets sent back to the model — kept minimal and structured, not a raw dump. */
  summary: string;
  artifactId?: string;
  isError?: boolean;
}

export interface ToolDef<TInput = any> {
  name: string;
  description: string;
  /** Third generic left open so schemas built with z.default()/.optional() (whose parsed _input differs from output) still satisfy this. */
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, any>;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
