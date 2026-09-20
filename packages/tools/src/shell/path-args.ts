import fs from "node:fs";
import path from "node:path";
import { SandboxViolationError, type ActorContext, type PathGuard } from "@kuclab-hertz/sandbox";

function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Symlink-aware containment for absolute candidates: check the normalized form and the on-disk real path. */
function absoluteEscapesRoot(root: string, candidate: string): boolean {
  const normalized = path.normalize(candidate);
  if (!isWithin(root, normalized)) return true;
  try {
    const real = fs.realpathSync.native(normalized);
    if (!isWithin(root, real)) return true;
  } catch {
    // Not fully on disk — the normalized prefix check above stands.
  }
  return false;
}

/** True for args that could name a filesystem path: contain a separator or look relative. */
export function isPathLikeArg(arg: string): boolean {
  if (arg.includes("/") || arg.includes("\\")) return true;
  if (arg === "." || arg === "..") return true;
  if (arg.startsWith("./") || arg.startsWith("../") || arg.startsWith(".\\")) return true;
  return false;
}

/**
 * Split `--flag=value` / `name=value` forms so the value half is scanned too
 * (`--output=/etc/x` must not slip past). Plain args come back unchanged.
 */
function candidatesFor(arg: string): string[] {
  const eq = arg.indexOf("=");
  if (eq > 0 && !arg.startsWith("=")) {
    const value = arg.slice(eq + 1);
    if (value) return [arg, value];
  }
  return [arg];
}

export interface BlockedShellArg {
  arg: string;
  reason: string;
}

/**
 * Contain shell argv paths inside the agent's root: every path-like arg must
 * resolve within `rootId` (relative args via PathGuard.resolve, absolute args
 * via prefix containment against the root — resolve() would misread an
 * absolute host path as root-relative). Returns the first escape, if any.
 * Non-path args pass through untouched.
 *
 * Residual risk (documented): this is heuristic — `git -C /`, `find /`,
 * `VAR=val` env prefixes and flag spellings the splitter doesn't know can
 * still wander. Inside the container the blast radius is mounts-only (user
 * approved); the local backend is deprecated for exactly this reason.
 */
export function scanShellArgs(
  pathGuard: PathGuard,
  actor: ActorContext,
  rootId: string,
  args: string[],
): BlockedShellArg | undefined {
  let root: string | undefined;
  for (const arg of args) {
    for (const candidate of candidatesFor(arg)) {
      if (!isPathLikeArg(candidate)) continue;
      if (path.isAbsolute(candidate)) {
        try {
          root ??= pathGuard.getRoot(rootId);
        } catch (err) {
          if (err instanceof SandboxViolationError) return { arg, reason: (err as Error).message };
          throw err;
        }
        if (absoluteEscapesRoot(root, candidate)) {
          return { arg, reason: `absolute path escapes project root: ${candidate}` };
        }
        continue;
      }
      try {
        pathGuard.resolve(actor, rootId, candidate);
      } catch (err) {
        if (err instanceof SandboxViolationError) return { arg, reason: (err as Error).message };
        throw err;
      }
    }
  }
  return undefined;
}
