import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBudget, estimateTokensFromChars, needsSummarization } from "../dist/context/budget.js";

describe("context budget", () => {
  it("estimates ~4 chars per token", () => {
    assert.equal(estimateTokensFromChars(400), 100);
    assert.equal(estimateTokensFromChars(0), 0);
  });

  it("computes usage from the latest message totals", () => {
    const budget = computeBudget([
      { tokensIn: 100, tokensOut: 50, cachedTokensIn: 0 },
      { tokensIn: 1000, tokensOut: 200, cachedTokensIn: 300 },
    ]);
    assert.equal(budget.used, 1200);
    assert.equal(budget.cachedPortion, 300);
    assert.equal(budget.limit, 200_000);
    assert.equal(budget.percent, 1);
  });

  it("handles empty history and clamps percent at 100", () => {
    assert.equal(computeBudget([]).used, 0);
    const over = computeBudget([{ tokensIn: 500_000, tokensOut: 0, cachedTokensIn: 0 }]);
    assert.equal(over.percent, 100);
  });

  it("flags summarization past the threshold", () => {
    assert.ok(needsSummarization({ used: 1, cachedPortion: 0, limit: 100, percent: 60 }));
    assert.ok(!needsSummarization({ used: 1, cachedPortion: 0, limit: 100, percent: 59 }));
    assert.ok(needsSummarization({ used: 1, cachedPortion: 0, limit: 100, percent: 90 }, 90));
  });
});
