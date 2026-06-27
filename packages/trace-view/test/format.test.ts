import { describe, expect, it } from "vitest";
import { fmtCost, fmtDuration, fmtSummary, fmtTokens } from "../src/format.ts";

describe("format", () => {
  it("formats durations", () => {
    expect(fmtDuration(undefined)).toBe("—");
    expect(fmtDuration(820)).toBe("820ms");
    expect(fmtDuration(12400)).toBe("12.4s");
  });

  it("formats cost with more precision under a cent fraction", () => {
    expect(fmtCost(undefined)).toBe("");
    expect(fmtCost(0.21)).toBe("$0.21");
    expect(fmtCost(0.0023)).toBe("$0.0023");
  });

  it("formats tokens", () => {
    expect(fmtTokens(10)).toBe("10tok");
  });

  it("builds a one-line summary, omitting empty cost", () => {
    expect(
      fmtSummary(
        {
          inputTokens: 1,
          outputTokens: 9,
          totalTokens: 10,
          costUsd: 0.21,
          calls: 2,
          maxCallDepth: 0,
        },
        12400,
      ),
    ).toBe("12.4s  10tok  $0.21  2 calls");
    expect(
      fmtSummary({ inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, maxCallDepth: 0 }, 5),
    ).toBe("5ms  0tok");
  });
});
