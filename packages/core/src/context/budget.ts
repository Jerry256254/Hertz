export interface BudgetInfo {
  used: number;
  cachedPortion: number;
  limit: number;
  percent: number;
}

const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Cheap pre-flight estimate for UI display before a response's real usage numbers land. */
export function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / 4);
}

export function computeBudget(
  history: Array<{ tokensIn: number; tokensOut: number; cachedTokensIn: number }>,
  limit: number = DEFAULT_CONTEXT_LIMIT,
): BudgetInfo {
  const last = history[history.length - 1];
  const used = last ? last.tokensIn + last.tokensOut : 0;
  const cachedPortion = last ? last.cachedTokensIn : 0;
  return { used, cachedPortion, limit, percent: Math.min(100, Math.round((used / limit) * 100)) };
}

/** Turn count/token threshold past which core/context/summarizer.ts (M2) should compact history. */
export function needsSummarization(budget: BudgetInfo, thresholdPercent = 60): boolean {
  return budget.percent >= thresholdPercent;
}
