import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentMemoryAtoms } from "../db/schema.js";
import type { HertzPaths } from "../paths.js";
import { loadAgentMemoryConfig } from "./config.js";
import { getAgentEmbedder } from "./embed.js";

/**
 * Vector sidecar for L1 atoms — the local TencentDB-style engine: plain
 * `node:sqlite` plus the `sqlite-vec` extension (vec0 cosine search).
 *
 * Same resilience contract as upstream: if the native extension can't load
 * (missing prebuild, wrong platform), the store enters degraded mode and
 * every operation becomes a silent no-op — recall falls back to keywords.
 */

export interface VectorHit {
  atomId: string;
  /** Cosine similarity, clamped 0–1. */
  score: number;
}

const require = createRequire(import.meta.url);

function toBlob(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

export class VectorMemoryStore {
  private db: DatabaseSync | null = null;
  private filePath: string;
  private dims = 0;
  degraded = true;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Opens the DB and loads sqlite-vec. Idempotent per dimensions; when the
   * embedding dimensions changed since last init, vec tables are rebuilt and
   * needsReindex is returned so the caller can re-embed everything.
   */
  init(dimensions: number): { ok: boolean; needsReindex: boolean; reason?: string } {
    if (this.db && !this.degraded && this.dims === dimensions) return { ok: true, needsReindex: false };
    this.close();
    this.dims = dimensions;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Extension loading must be allowed at creation — flipping it later throws.
      const db = new DatabaseSync(this.filePath, { allowExtension: true });
      db.exec("PRAGMA journal_mode = WAL;");
      try {
        const sqliteVec = require("sqlite-vec") as { load: (db: unknown) => void };
        sqliteVec.load(db);
      } catch (err) {
        db.close();
        this.degraded = true;
        return { ok: false, needsReindex: false, reason: `sqlite-vec load failed: ${(err as Error).message}` };
      }
      this.db = db;
      this.degraded = false;
      return { ok: true, needsReindex: this.initSchema(dimensions) };
    } catch (err) {
      this.close();
      this.degraded = true;
      return { ok: false, needsReindex: false, reason: (err as Error).message };
    }
  }

  private initSchema(dimensions: number): boolean {
    const db = this.db!;
    db.exec("CREATE TABLE IF NOT EXISTS vec_meta (key TEXT PRIMARY KEY, value TEXT);");
    db.exec("CREATE TABLE IF NOT EXISTS atom_meta (atom_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 2);");
    const row = db.prepare("SELECT value FROM vec_meta WHERE key = 'dims'").get() as { value?: unknown } | undefined;
    const prev = typeof row?.value === "string" ? Number(row.value) : NaN;
    if (Number.isFinite(prev) && prev !== dimensions) {
      db.exec("DROP TABLE IF EXISTS atom_vec;");
      db.exec("DELETE FROM atom_meta;");
      db.prepare("INSERT OR REPLACE INTO vec_meta (key, value) VALUES ('dims', ?)").run(String(dimensions));
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS atom_vec USING vec0(embedding FLOAT[${dimensions}]);`);
      return true;
    }
    db.prepare("INSERT OR IGNORE INTO vec_meta (key, value) VALUES ('dims', ?)").run(String(dimensions));
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS atom_vec USING vec0(embedding FLOAT[${dimensions}]);`);
    return false;
  }

  /** Upsert = delete + insert (vec0 has no ON CONFLICT). Rowids join meta ↔ vector. */
  upsertAtom(atomId: string, agentId: string, importance: number, embedding: number[]): boolean {
    if (this.degraded || !this.db || embedding.length !== this.dims) return false;
    try {
      const db = this.db;
      db.exec("BEGIN;");
      try {
        db.prepare("INSERT OR REPLACE INTO atom_meta (atom_id, agent_id, importance) VALUES (?, ?, ?)").run(atomId, agentId, importance);
        const meta = db.prepare("SELECT rowid AS rowid FROM atom_meta WHERE atom_id = ?").get(atomId) as { rowid?: number | bigint } | undefined;
        const rowid = Number(meta?.rowid ?? NaN);
        if (!Number.isFinite(rowid)) throw new Error("meta rowid missing");
        // vec0 strictly requires INTEGER rowids; node:sqlite binds JS numbers
        // as REAL, so rowids cross the boundary as bigint.
        db.prepare("DELETE FROM atom_vec WHERE rowid = ?").run(BigInt(rowid));
        db.prepare("INSERT INTO atom_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(rowid), toBlob(embedding));
        db.exec("COMMIT;");
        return true;
      } catch (err) {
        try { db.exec("ROLLBACK;"); } catch { /* already failed */ }
        throw err;
      }
    } catch {
      return false;
    }
  }

  removeAtom(atomId: string): void {
    if (this.degraded || !this.db) return;
    try {
      const meta = this.db.prepare("SELECT rowid AS rowid FROM atom_meta WHERE atom_id = ?").get(atomId) as { rowid?: number | bigint } | undefined;
      if (meta?.rowid !== undefined) this.db.prepare("DELETE FROM atom_vec WHERE rowid = ?").run(BigInt(meta.rowid));
      this.db.prepare("DELETE FROM atom_meta WHERE atom_id = ?").run(atomId);
    } catch {
      /* best effort */
    }
  }

  removeAgent(agentId: string): void {
    if (this.degraded || !this.db) return;
    try {
      const rows = this.db.prepare("SELECT rowid AS rowid FROM atom_meta WHERE agent_id = ?").all(agentId) as Array<{ rowid?: number | bigint }>;
      const del = this.db.prepare("DELETE FROM atom_vec WHERE rowid = ?");
      for (const row of rows) {
        if (row.rowid !== undefined) del.run(BigInt(row.rowid));
      }
      this.db.prepare("DELETE FROM atom_meta WHERE agent_id = ?").run(agentId);
    } catch {
      /* best effort */
    }
  }

  knownAtomIds(agentId: string): Set<string> {
    if (this.degraded || !this.db) return new Set();
    try {
      const rows = this.db.prepare("SELECT atom_id AS atom_id FROM atom_meta WHERE agent_id = ?").all(agentId) as Array<{ atom_id?: unknown }>;
      return new Set(rows.map((r) => String(r.atom_id)));
    } catch {
      return new Set();
    }
  }

  search(embedding: number[], limit: number): VectorHit[] {
    if (this.degraded || !this.db || embedding.length !== this.dims) return [];
    try {
      const rows = this.db
        .prepare("SELECT rowid AS rowid, distance FROM atom_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?")
        .all(toBlob(embedding), Math.max(1, limit)) as Array<{ rowid?: number | bigint; distance?: number }>;
      const idOf = this.db.prepare("SELECT atom_id AS atom_id FROM atom_meta WHERE rowid = ?");
      const hits: VectorHit[] = [];
      for (const row of rows) {
        if (row.rowid === undefined || typeof row.distance !== "number") continue;
        const meta = idOf.get(Number(row.rowid)) as { atom_id?: unknown } | undefined;
        if (!meta?.atom_id) continue;
        hits.push({ atomId: String(meta.atom_id), score: Math.min(1, Math.max(0, 1 - row.distance)) });
      }
      return hits;
    } catch {
      return [];
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
    this.degraded = true;
  }
}

const stores = new Map<string, VectorMemoryStore>();

/** Process-wide singleton per vector DB file (node:sqlite handles are not shareable across instances). */
export function getVectorStore(paths: HertzPaths, fileName: string): VectorMemoryStore {
  const file = path.join(paths.dataDir, fileName);
  let store = stores.get(file);
  if (!store) {
    store = new VectorMemoryStore(file);
    stores.set(file, store);
  }
  return store;
}

/**
 * Embeds a query and returns vector-ordered atom ids (best-first). Empty when
 * embeddings or the native extension are unavailable — callers fall back to
 * keyword ranking. `db` is only used to resolve the agent's embedder.
 */
export async function searchAtomVectors(db: Database, paths: HertzPaths, agentId: string, query: string, limit: number): Promise<string[]> {
  try {
    const config = loadAgentMemoryConfig();
    const embedder = await getAgentEmbedder(db, agentId);
    if (!embedder || !query.trim()) return [];
    const store = getVectorStore(paths, config.vectorDbFileName);
    const init = store.init(embedder.dimensions);
    if (!init.ok) return [];
    const [vec] = await embedder.embedBatch([query]);
    if (!vec) return [];
    return store.search(vec, limit).map((h) => h.atomId);
  } catch {
    return [];
  }
}

/**
 * Ensures every L1 atom of the agent has a vector: embeds what's missing, in
 * batches, bounded per call. Fire-and-forget from the pipeline; silently
 * no-ops without an embedder or sqlite-vec.
 */
export async function syncAtomVectors(db: Database, paths: HertzPaths, agentId: string): Promise<number> {
  try {
    const config = loadAgentMemoryConfig();
    const embedder = await getAgentEmbedder(db, agentId);
    if (!embedder) return 0;
    const store = getVectorStore(paths, config.vectorDbFileName);
    const init = store.init(embedder.dimensions);
    if (!init.ok) return 0;
    const atoms = await db
      .select({ id: agentMemoryAtoms.id, text: agentMemoryAtoms.text, importance: agentMemoryAtoms.importance })
      .from(agentMemoryAtoms)
      .where(eq(agentMemoryAtoms.agentId, agentId))
      .limit(2000);
    const known = store.knownAtomIds(agentId);
    const missing = atoms.filter((a) => !known.has(a.id)).slice(0, Math.max(0, config.reindexPerRun));
    let done = 0;
    for (let i = 0; i < missing.length; i += config.embedBatchSize) {
      const batch = missing.slice(i, i + config.embedBatchSize);
      const vectors = await embedder.embedBatch(batch.map((a) => a.text));
      batch.forEach((atom, j) => {
        const vec = vectors[j];
        if (vec && store.upsertAtom(atom.id, agentId, atom.importance, vec)) done++;
      });
    }
    return done;
  } catch {
    return 0;
  }
}

/** Removes one atom's vector (best effort, no embedder needed). */
export function removeAtomVector(paths: HertzPaths, atomId: string): void {
  try {
    const config = loadAgentMemoryConfig();
    const store = getVectorStore(paths, config.vectorDbFileName);
    if (store.degraded && !tryInitForDelete(store, config.embedDimensions)) return;
    store.removeAtom(atomId);
  } catch {
    /* best effort */
  }
}

/** Removes all vectors of an agent (memory wipe path, no embedder needed). */
export function removeAgentVectors(paths: HertzPaths, agentId: string): void {
  try {
    const config = loadAgentMemoryConfig();
    const store = getVectorStore(paths, config.vectorDbFileName);
    if (store.degraded && !tryInitForDelete(store, config.embedDimensions)) return;
    store.removeAgent(agentId);
  } catch {
    /* best effort */
  }
}

function tryInitForDelete(store: VectorMemoryStore, dimensions: number): boolean {
  try {
    return store.init(dimensions).ok;
  } catch {
    return false;
  }
}
