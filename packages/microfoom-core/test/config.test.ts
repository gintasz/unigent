import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AgentConfig, Duration } from "../src/index.ts";
import { durationToMs, mergeConfig, mergeConfigChain } from "../src/index.ts";

const durationArb: fc.Arbitrary<Duration> = fc
  .tuple(fc.integer({ min: 0, max: 10_000 }), fc.constantFrom("s", "m", "h"))
  .map(([n, unit]) => `${n}${unit}` as Duration);

const configArb: fc.Arbitrary<AgentConfig> = fc.record(
  {
    model: fc.string(),
    thinking: fc.constantFrom("low", "medium", "high"),
    retries: fc.integer({ min: 0, max: 5 }),
    repairAttempts: fc.integer({ min: 0, max: 5 }),
    systemPrompt: fc.oneof(fc.record({ append: fc.string() }), fc.record({ replace: fc.string() })),
    maxBudgetUsd: fc.double({ min: 0, max: 1000, noNaN: true }),
    maxOutputTokens: fc.integer({ min: 0, max: 1_000_000 }),
    maxCallDepth: fc.integer({ min: 0, max: 100 }),
    maxConcurrentRootTurns: fc.integer({ min: 1, max: 100 }),
    maxTurnDuration: durationArb,
  },
  { requiredKeys: [] },
);

describe("durationToMs", () => {
  it("converts units", () => {
    expect(durationToMs("30s")).toBe(30_000);
    expect(durationToMs("10m")).toBe(600_000);
    expect(durationToMs("2h")).toBe(7_200_000);
  });
});

describe("config cascade (F5)", () => {
  it("override fields take the nearest (narrower) defined value", () => {
    const merged = mergeConfig({ model: "a", thinking: "low" }, { model: "b" });
    expect(merged.model).toBe("b");
    expect(merged.thinking).toBe("low");
  });

  it("a narrower scope cannot loosen a cap (tighten-only)", () => {
    const merged = mergeConfig(
      { maxBudgetUsd: 5, maxConcurrentRootTurns: 2 },
      { maxBudgetUsd: 100, maxConcurrentRootTurns: 8 },
    );
    expect(merged.maxBudgetUsd).toBe(5);
    expect(merged.maxConcurrentRootTurns).toBe(2);
  });

  it("append accumulates onto an inherited base", () => {
    const merged = mergeConfig(
      { systemPrompt: { replace: "base" } },
      { systemPrompt: { append: "more" } },
    );
    expect(merged.systemPrompt).toEqual({ replace: "base\nmore" });
  });

  it("replace at a narrower scope discards the wider prompt", () => {
    const merged = mergeConfig(
      { systemPrompt: { append: "wide" } },
      { systemPrompt: { replace: "fresh" } },
    );
    expect(merged.systemPrompt).toEqual({ replace: "fresh" });
  });

  it("property: caps never loosen across a merge", () => {
    fc.assert(
      fc.property(configArb, configArb, (wider, narrower) => {
        const merged = mergeConfig(wider, narrower);
        for (const inherited of [wider.maxBudgetUsd, narrower.maxBudgetUsd]) {
          if (inherited !== undefined && merged.maxBudgetUsd !== undefined) {
            expect(merged.maxBudgetUsd).toBeLessThanOrEqual(inherited);
          }
        }
        for (const inherited of [wider.maxConcurrentRootTurns, narrower.maxConcurrentRootTurns]) {
          if (inherited !== undefined && merged.maxConcurrentRootTurns !== undefined) {
            expect(merged.maxConcurrentRootTurns).toBeLessThanOrEqual(inherited);
          }
        }
      }),
    );
  });

  it("property: merge is associative", () => {
    fc.assert(
      fc.property(configArb, configArb, configArb, (a, b, c) => {
        const left = mergeConfig(mergeConfig(a, b), c);
        const right = mergeConfig(a, mergeConfig(b, c));
        expect(left).toEqual(right);
      }),
    );
  });

  it("property: chain fold equals left-associated pairwise merge", () => {
    fc.assert(
      fc.property(fc.array(configArb, { maxLength: 6 }), (scopes) => {
        const folded = mergeConfigChain(scopes);
        const manual = scopes.reduce<AgentConfig>((acc, s) => mergeConfig(acc, s), {});
        expect(folded).toEqual(manual);
      }),
    );
  });
});
