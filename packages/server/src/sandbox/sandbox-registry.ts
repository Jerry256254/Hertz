import { PathGuard, loadDefaultPolicy, type AuditSink, type ProjectRoots } from "@kuclab-hertz/sandbox";
import type { SandboxBundle } from "@kuclab-hertz/core";
import { createFileArtifactStore } from "../persistence/artifact-store.js";
import type { HertzPaths } from "../paths.js";

/**
 * AgentLoopManager looks up a session's SandboxBundle synchronously, so it must
 * be built and registered *before* the loop starts (the route handler that kicks
 * off a run resolves the project's roots from the DB and calls register() first).
 */
export class SandboxRegistry {
  private readonly bundles = new Map<string, SandboxBundle>();
  private readonly artifacts;

  constructor(
    private readonly audit: AuditSink,
    paths: HertzPaths,
  ) {
    this.artifacts = createFileArtifactStore(paths);
  }

  register(sessionId: string, roots: ProjectRoots, computer?: SandboxBundle["computer"], browser?: SandboxBundle["browser"]): SandboxBundle {
    const bundle: SandboxBundle = {
      pathGuard: new PathGuard(roots, this.audit),
      shellPolicy: loadDefaultPolicy(),
      audit: this.audit,
      artifacts: this.artifacts,
      ...(computer ? { computer } : {}),
      ...(browser ? { browser } : {}),
    };
    this.bundles.set(sessionId, bundle);
    return bundle;
  }

  get(sessionId: string): SandboxBundle {
    const bundle = this.bundles.get(sessionId);
    if (!bundle) throw new Error(`No sandbox registered for session ${sessionId}`);
    return bundle;
  }

  /** For one-off, user-initiated path resolution (file explorer) outside any agent session. */
  buildPathGuard(roots: ProjectRoots): PathGuard {
    return new PathGuard(roots, this.audit);
  }
}
