import { describe, expect, it } from "vitest";
import { fmtCost, fmtDuration, fmtSummary, fmtTokens } from "../src/format.ts";

describe("format", () => {
  it("formats durations without milliseconds, rolling into minutes and hours", () => {
    expect(fmtDuration(undefined)).toBe("—");
    expect(fmtDuration(400)).toBe("<1s");
    expect(fmtDuration(820)).toBe("1s");
    expect(fmtDuration(12_400)).toBe("12s");
    expect(fmtDuration(90_000)).toBe("1m 30s");
    expect(fmtDuration(3_675_000)).toBe("1h 01m");
  });

  it("formats cost with more precision under a cent fraction", () => {
    expect(fmtCost(undefined)).toBe("");
    expect(fmtCost(0.21)).toBe("$0.21");
    expect(fmtCost(0.0023)).toBe("$0.0023");
  });

  it("formats tokens compactly with k/M above a thousand", () => {
    expect(fmtTokens(10)).toBe("10tok");
    expect(fmtTokens(842)).toBe("842tok");
    expect(fmtTokens(68_901)).toBe("68.9ktok");
    expect(fmtTokens(100_000)).toBe("0.1Mtok");
    expect(fmtTokens(620_816)).toBe("0.6Mtok");
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
        12_400,
      ),
    ).toBe("12s  10tok  $0.21");
    expect(
      fmtSummary({ inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, maxCallDepth: 0 }, 5),
    ).toBe("<1s  0tok");
  });
});
