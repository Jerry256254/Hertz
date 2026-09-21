import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { newId } from "../db/client.js";
import { vaultCredentials } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "./key-encryption.js";

/** Credential metadata — everything the agent and the UI are allowed to see. */
export interface VaultCredentialMeta {
  id: string;
  service: string;
  label: string;
  username: string;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultCredentialInput {
  service: string;
  label: string;
  username: string;
  /** Plaintext secret — encrypted with the master key before it touches the DB. */
  secret: string;
  note?: string | null;
}

export interface VaultCredentialPatch {
  service?: string;
  label?: string;
  username?: string;
  /** When present, the stored secret is re-encrypted. */
  secret?: string;
  note?: string | null;
}

const MAX_FIELD = 200;
const MAX_NOTE = 2000;

function clean(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function toMeta(row: typeof vaultCredentials.$inferSelect): VaultCredentialMeta {
  return {
    id: row.id,
    service: row.service,
    label: row.label,
    username: row.username,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Stores a new credential. The secret is encrypted with the master key
 * (AES-256-GCM); only the ciphertext is persisted — plaintext never reaches
 * the database, the logs, or any API response.
 */
export async function createVaultCredential(
  db: Database,
  masterKey: Buffer,
  input: VaultCredentialInput,
  createdByUserId?: string,
): Promise<VaultCredentialMeta> {
  if (!input.secret) throw new Error("Secret must not be empty");
  const now = new Date();
  const row = {
    id: newId(),
    service: clean(input.service, MAX_FIELD),
    label: clean(input.label, MAX_FIELD),
    username: clean(input.username, MAX_FIELD),
    encryptedSecret: encryptSecret(masterKey, input.secret),
    note: input.note?.trim() ? clean(input.note, MAX_NOTE) : null,
    createdByUserId: createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  if (!row.service || !row.label || !row.username) {
    throw new Error("service, label and username are required");
  }
  await db.insert(vaultCredentials).values(row);
  return toMeta(row);
}

/**
 * Lists stored credentials — METADATA ONLY. The encrypted secret column is
 * deliberately not selected, so even a bug in a caller cannot leak it.
 */
export async function listVaultCredentials(db: Database): Promise<VaultCredentialMeta[]> {
  const rows = await db
    .select({
      id: vaultCredentials.id,
      service: vaultCredentials.service,
      label: vaultCredentials.label,
      username: vaultCredentials.username,
      note: vaultCredentials.note,
      createdAt: vaultCredentials.createdAt,
      updatedAt: vaultCredentials.updatedAt,
    })
    .from(vaultCredentials)
    .orderBy(desc(vaultCredentials.createdAt));
  return rows;
}

export async function getVaultCredentialMeta(db: Database, id: string): Promise<VaultCredentialMeta | undefined> {
  const rows = await db
    .select({
      id: vaultCredentials.id,
      service: vaultCredentials.service,
      label: vaultCredentials.label,
      username: vaultCredentials.username,
      note: vaultCredentials.note,
      createdAt: vaultCredentials.createdAt,
      updatedAt: vaultCredentials.updatedAt,
    })
    .from(vaultCredentials)
    .where(eq(vaultCredentials.id, id))
    .limit(1);
  return rows[0];
}

export async function updateVaultCredential(
  db: Database,
  masterKey: Buffer,
  id: string,
  patch: VaultCredentialPatch,
): Promise<VaultCredentialMeta | undefined> {
  const existing = await db.select().from(vaultCredentials).where(eq(vaultCredentials.id, id)).limit(1);
  if (!existing[0]) return undefined;
  const update: Partial<typeof vaultCredentials.$inferInsert> = { updatedAt: new Date() };
  if (patch.service !== undefined) update.service = clean(patch.service, MAX_FIELD);
  if (patch.label !== undefined) update.label = clean(patch.label, MAX_FIELD);
  if (patch.username !== undefined) update.username = clean(patch.username, MAX_FIELD);
  if (patch.note !== undefined) update.note = patch.note?.trim() ? clean(patch.note, MAX_NOTE) : null;
  if (patch.secret !== undefined) {
    if (!patch.secret) throw new Error("Secret must not be empty");
    update.encryptedSecret = encryptSecret(masterKey, patch.secret);
  }
  await db.update(vaultCredentials).set(update).where(eq(vaultCredentials.id, id));
  return getVaultCredentialMeta(db, id);
}

export async function deleteVaultCredential(db: Database, id: string): Promise<boolean> {
  const res = await db.delete(vaultCredentials).where(eq(vaultCredentials.id, id));
  return (res.rowsAffected ?? 0) > 0;
}

/**
 * SERVER-SIDE ONLY: decrypts the stored secret. The result must never be
 * placed in a tool result, message history, log line, or API response — it
 * goes straight into an in-memory single-use grant (see vault-grants.ts).
 */
export async function decryptVaultSecret(
  db: Database,
  masterKey: Buffer,
  id: string,
): Promise<{ username: string; secret: string } | undefined> {
  const rows = await db
    .select({ username: vaultCredentials.username, encryptedSecret: vaultCredentials.encryptedSecret })
    .from(vaultCredentials)
    .where(eq(vaultCredentials.id, id))
    .limit(1);
  if (!rows[0]) return undefined;
  return { username: rows[0].username, secret: decryptSecret(masterKey, rows[0].encryptedSecret) };
}
