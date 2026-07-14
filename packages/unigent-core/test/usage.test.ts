import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AgentUsage } from "../src/usage.ts";
import { combineUsage, emptyUsage } from "../src/usage.ts";

const usageArbitrary: fc.Arbitrary<AgentUsage> = fc
  .record({
    inputTokens: fc.nat(),
    outputTokens: fc.nat(),
    cachedInputTokens: fc.option(fc.nat(), { nil: undefined }),
    reasoningTokens: fc.option(fc.nat(), { nil: undefined }),
    calls: fc.nat({ max: 10 }),
    costUsd: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
  })
  .map((usage) => ({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    calls: usage.calls,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.calls === 0 || usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  }));

describe("usage algebra", () => {
  it("is associative with an empty identity", () => {
    fc.assert(
      fc.property(usageArbitrary, usageArbitrary, usageArbitrary, (left, middle, right) => {
        const leftGrouped = combineUsage(combineUsage(left, middle), right);
        const rightGrouped = combineUsage(left, combineUsage(middle, right));
        const { costUsd: leftCost, ...leftCounts } = leftGrouped;
        const { costUsd: rightCost, ...rightCounts } = rightGrouped;

        expect(leftCounts).toEqual(rightCounts);
        if (leftCost === undefined || rightCost === undefined) {
          expect(leftCost).toBe(rightCost);
        } else {
          const roundingTolerance =
            Number.EPSILON * Math.max(1, Math.abs(leftCost), Math.abs(rightCost)) * 4;
          expect(Math.abs(leftCost - rightCost)).toBeLessThanOrEqual(roundingTolerance);
        }
        expect(combineUsage(emptyUsage(), left)).toEqual(combineUsage(left, emptyUsage()));
      }),
    );
  });

  it("keeps cost unknown once a non-empty unpriced usage participates", () => {
    const priced: AgentUsage = {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      calls: 1,
      costUsd: 0.5,
    };
    const unpriced: AgentUsage = {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      calls: 1,
    };

    expect(combineUsage(priced, unpriced).costUsd).toBeUndefined();
    expect(combineUsage(unpriced, priced).costUsd).toBeUndefined();
  });
});
