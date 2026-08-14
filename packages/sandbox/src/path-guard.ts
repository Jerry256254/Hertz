import fs from "node:fs";
import path from "node:path";
import type { ActorContext, AuditSink } from "./audit.js";
import { NullAuditSink } from "./audit.js";

export class SandboxViolationError extends Error {
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "SandboxViolationError";
    this.detail = detail;
  }
}

/** True if `target` is `root` itself or a descendant of it (proper prefix check, not naive startsWith). */
function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolves symlinks for as much of `target` as exists on disk, then reappends the
 * not-yet-existing tail unresolved (a path that doesn't exist yet can't be a symlink).
 * This lets write-of-a-new-file paths be containment-checked the same way as reads.
 */
function realpathExisting(target: string): string {
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding an existing ancestor.
        return target;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export type ProjectRoots = Record<string, string>;

/**
 * The sole chokepoint for containing agent/tool filesystem access within declared
 * project roots. Every path a tool touches must go through `resolve()` — nothing
 * else in the codebase should call `fs.realpath`/containment logic directly.
 */
export class PathGuard {
  private readonly roots: Map<string, string>;
  private readonly audit: AuditSink;

  constructor(roots: ProjectRoots, audit: AuditSink = new NullAuditSink()) {
    this.roots = new Map(
      Object.entries(roots).map(([id, p]) => [id, fs.realpathSync.native(p)]),
    );
    this.audit = audit;
  }

  listRootIds(): string[] {
    return [...this.roots.keys()];
  }

  /** The resolved (symlink-free) absolute path of a declared root, for tools that need a base cwd (glob, grep). */
  getRoot(rootId: string): string {
    const root = this.roots.get(rootId);
    if (!root) throw new SandboxViolationError(`Unknown project root: ${rootId}`, { rootId });
    return root;
  }

  /**
   * Resolve `relPath` against `rootId`, guaranteeing the result stays within that
   * root even through symlinks. Throws SandboxViolationError and records a denial
   * on any escape attempt. Re-checked on every call — never cached from project-open
   * time, since a session can create a symlink mid-run and read through it later.
   */
  resolve(ctx: ActorContext, rootId: string, relPath: string): string {
    const root = this.roots.get(rootId);
    if (!root) {
      this.audit.record({
        ...ctx,
        action: "path.resolve",
        target: `${rootId}:${relPath}`,
        targetType: "path",
        result: "denied",
        detail: { reason: "unknown-root" },
      });
      throw new SandboxViolationError(`Unknown project root: ${rootId}`, { rootId });
    }

    const cleanRel = relPath.replace(/^[/\\]+/, "");
    const target = path.resolve(root, cleanRel);

    if (!isWithin(root, target)) {
      this.audit.record({
        ...ctx,
        action: "path.resolve",
        target,
        targetType: "path",
        result: "denied",
        detail: { reason: "escapes-root", root, relPath },
      });
      throw new SandboxViolationError("Path escapes project root", { root, relPath, target });
    }

    const real = realpathExisting(target);
    if (!isWithin(root, real)) {
      this.audit.record({
        ...ctx,
        action: "path.resolve",
        target,
        targetType: "path",
        result: "denied",
        detail: { reason: "escapes-root-via-symlink", root, relPath, real },
      });
      throw new SandboxViolationError("Path escapes project root via symlink", {
        root,
        relPath,
        target,
        real,
      });
    }

    this.audit.record({
      ...ctx,
      action: "path.resolve",
      target,
      targetType: "path",
      result: "allowed",
    });
    return target;
  }
}
