/**
 * Session-scoped approval grants ("Povolit pro session" on the Telegram
 * approval card). When the user pre-approves an action for the whole session,
 * the grant is recorded here and the next identical approval request from the
 * same session executes immediately instead of parking — for every approval
 * kind (generic request_approval, host_access, vault_use, mcp_op).
 *
 * In-memory, like the vault grant: a server restart drops the grants, which
 * is the safe default (the user taps the button again). Entries expire after
 * 12 hours so a leaked session id can't grant forever.
 */

const GRANT_TTL_MS = 12 * 60 * 60 * 1000;

interface Grant {
  key: string;
  /** User id that issued the grant (for the audit trail). */
  grantedBy?: string;
  expiresAt: number;
}

const grants = new Map<string, Grant[]>();

/** Stable grant key: the approval kind plus a tool-specific stable scope. */
export function sessionApprovalKey(kind: string, scope: string): string {
  return `${kind}:${scope}`;
}

/** Normalized summary for generic approvals — tolerant to small rewordings. */
export function normalizeApprovalSummary(summary: string): string {
  return summary.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Record that the user pre-approved `key` for the rest of `sessionId`. */
export function grantSessionApproval(sessionId: string, key: string, grantedBy?: string): void {
  const list = grants.get(sessionId) ?? [];
  if (!list.some((g) => g.key === key)) {
    list.push({ key, grantedBy, expiresAt: Date.now() + GRANT_TTL_MS });
  }
  grants.set(sessionId, list);
}

/** Live grant info for `key`, or undefined when no grant covers it. */
export function sessionGrantInfo(sessionId: string, key: string): { grantedBy?: string } | undefined {
  return hasSessionApproval(sessionId, key)
    ? (() => {
        const list = grants.get(sessionId) ?? [];
        const found = list.find((g) => g.key === key);
        return found ? { grantedBy: found.grantedBy } : undefined;
      })()
    : undefined;
}

/** True when a live grant covers `key` in `sessionId`. Grants are not consumed — they last the session. */
export function hasSessionApproval(sessionId: string, key: string): boolean {
  const list = grants.get(sessionId);
  if (!list || list.length === 0) return false;
  const now = Date.now();
  const live = list.filter((g) => g.expiresAt > now);
  if (live.length !== list.length) {
    if (live.length === 0) grants.delete(sessionId);
    else grants.set(sessionId, live);
  }
  return live.some((g) => g.key === key);
}

/** Drop all grants for a session (e.g. when the session is archived). */
export function clearSessionApprovals(sessionId: string): void {
  grants.delete(sessionId);
}
