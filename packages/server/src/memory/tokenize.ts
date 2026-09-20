/**
 * Keyword tokenization + hybrid scoring for layered recall.
 *
 * Pure functions (no db/fs) so the ranking behavior is unit-testable.
 * Retrieval fuses keyword overlap (BM25-lite over keyword sets), importance,
 * and recency — then Reciprocal-Rank-Fusion merges that keyword ranking with
 * the sqlite-vec cosine ranking (see vector-store.ts), the same hybrid
 * "progressive disclosure" idea as TencentDB Agent Memory, local-first on
 * plain SQLite.
 */

/** Lowercase word tokens, Czech + English alphabet, stop-word resistant by length. */
export function tokenize(text: string, minLen = 3): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9ěščřžýáíéúůñäöüß]+/)
    .filter((w) => w.length >= minLen);
}

/** Comma-separated keyword string stored on atoms (mirrors the legacy remember() format). */
export function keywordsFor(text: string, max = 12): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out.join(",");
}

/** Jaccard overlap of two keyword sets, 0–1 — used for dedup and relevance. */
export function keywordOverlap(aKeywords: string | null, bText: string): number {
  if (!aKeywords) return 0;
  const a = new Set(aKeywords.split(",").filter(Boolean));
  if (a.size === 0) return 0;
  const b = new Set(tokenize(bText));
  if (b.size === 0) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit++;
  return hit / (a.size + b.size - hit);
}

export interface Rankable {
  id: string;
  importance: number;
  keywords: string | null;
  createdAt: Date;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Scores items by fused rank: keyword relevance to the query/context (weight 3),
 * importance 1–5 (weight 1.2), and recency with a ~30-day half-life (weight 1).
 * Returns every item best-first — the keyword ranking side of RRF fusion.
 */
export function scoreByRelevance<T extends Rankable>(items: T[], contextText: string, now = Date.now()): Scored<T>[] {
  const contextTokens = new Set(tokenize(contextText, 4));
  const scored = items.map((item) => {
    let keywordHits = 0;
    if (contextTokens.size > 0 && item.keywords) {
      for (const kw of item.keywords.split(",")) {
        if (kw && contextTokens.has(kw)) keywordHits++;
      }
    }
    const keywordScore = Math.min(keywordHits, 5) / 5; // 0–1
    const ageDays = Math.max(0, (now - item.createdAt.getTime()) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / 30);
    const importance = Math.min(5, Math.max(1, item.importance)) / 5; // 0.2–1
    // RRF-flavored fusion: each signal contributes its normalized rank weight.
    const score = keywordScore * 3 + importance * 1.2 + recency * 1;
    return { item, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Scores items by fused rank (see scoreByRelevance) and returns the top
 * `limit` items, oldest-first for stable prompt narratives.
 */
export function rankByRelevance<T extends Rankable>(items: T[], contextText: string, limit: number, now = Date.now()): T[] {
  return scoreByRelevance(items, contextText, now)
    .slice(0, Math.max(0, limit))
    .sort((a, b) => a.item.createdAt.getTime() - b.item.createdAt.getTime())
    .map((s) => s.item);
}

/**
 * Near-duplicate check for freshly distilled atoms: same meaning usually shares
 * most keywords. Threshold ~0.55 catches rewordings without merging siblings.
 */
export function isNearDuplicate(candidateText: string, existingKeywords: string | null, threshold = 0.55): boolean {
  return keywordOverlap(existingKeywords, candidateText) >= threshold;
}

/**
 * Reciprocal Rank Fusion across retrieval signals (keyword ranking, vector
 * ranking, …). Each ranking is an id list ordered best-first; ids missing
 * from a ranking simply collect no score from it. Pure — the hybrid-recall
 * merger used by recall.ts.
 */
export function fuseRankings(ids: string[], rankings: string[][], limit: number, k = 60): string[] {
  const scores = new Map<string, number>();
  for (const id of ids) scores.set(id, 0);
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      if (scores.has(id)) scores.set(id, scores.get(id)! + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}
