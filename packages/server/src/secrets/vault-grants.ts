/**
 * In-memory, single-use, time-limited grants bridging an approved vault_use
 * approval and the actual fill. The decrypted secret lives ONLY here — never
 * in the DB, never in message history, never in a tool result or log.
 *
 * - Keyed by session id: the grant belongs to the run that requested it.
 * - Single-use: consumeVaultGrant deletes the grant as it hands it out.
 * - Time-limited: VAULT_GRANT_TTL_MS after approval the grant is dead.
 * - Process-local: a server restart wipes all grants (the approval stays
 *   decided; the agent simply files a fresh vault_use request).
 */
export interface VaultGrant {
  credentialId: string;
  label: string;
  username: string;
  secret: string;
  expiresAt: number;
}

export const VAULT_GRANT_TTL_MS = 5 * 60 * 1000;

const grants = new Map<string, VaultGrant>();

export function issueVaultGrant(sessionId: string, grant: VaultGrant): void {
  grants.set(sessionId, grant);
}

/**
 * Returns the grant and destroys it (single use). Returns undefined when
 * there is no grant for the session or it has expired — nothing leaks either
 * way.
 */
export function consumeVaultGrant(sessionId: string): VaultGrant | undefined {
  const grant = grants.get(sessionId);
  grants.delete(sessionId);
  if (!grant) return undefined;
  if (Date.now() > grant.expiresAt) return undefined;
  return grant;
}

/** Drops every outstanding grant for a credential (called when it is deleted). */
export function revokeVaultGrantsForCredential(credentialId: string): void {
  for (const [sessionId, grant] of grants) {
    if (grant.credentialId === credentialId) grants.delete(sessionId);
  }
}

/** Test / guard hook — non-destructive peek at an outstanding grant. */
export function peekVaultGrant(sessionId: string): VaultGrant | undefined {
  const grant = grants.get(sessionId);
  if (!grant) return undefined;
  if (Date.now() > grant.expiresAt) {
    grants.delete(sessionId);
    return undefined;
  }
  return grant;
}

/** Test / shutdown hook — wipes all outstanding grants. */
export function clearVaultGrants(): void {
  grants.clear();
}
