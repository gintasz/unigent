import { type AgentEvent, buildRunTree } from "@microfoom/core/trace";
import { describe, expect, it } from "vitest";
import { renderRunTree } from "../src/render.ts";

const u = (total: number, cost: number) => ({
  inputTokens: 0,
  outputTokens: total,
  totalTokens: total,
  costUsd: cost,
  calls: 1,
  maxCallDepth: 0,
});

const events: AgentEvent[] = [
  { type: "span_start", span: "main", name: "main", kind: "program" },
  { type: "span_start", span: "t1", parent: "main", name: "discoverRoutes", kind: "turn" },
  { type: "annotate", span: "t1", attributes: { routes: 3 } },
  { type: "log", span: "t1", message: "3 routes audited", level: "info" },
  { type: "span_end", span: "t1", durationMs: 2100, usage: u(2, 0.02) },
  { type: "span_end", span: "main", durationMs: 12400, usage: u(0, 0) },
];

describe("renderRunTree", () => {
  it("renders a tree with glyphs, indent, annotations, logs and right-aligned metrics", () => {
    const out = renderRunTree(buildRunTree(events), { width: 64, color: false });
    const lines = out.split("\n");

    // Parent has children → ▼; child turn is a leaf → ▸; child indented two spaces.
    expect(lines[0].startsWith("▼ main")).toBe(true);
    expect(lines[1].startsWith("  ▸ discoverRoutes  routes=3")).toBe(true);
    // Log line under the turn.
    expect(lines[2]).toContain("• 3 routes audited");

    // Metrics right-aligned to the width (rolled-up cost on main = child's 0.02;
    // sub-cent fraction renders at 4dp → $0.0200).
    expect(lines[0]).toContain("12.4s");
    expect(lines[0].trimEnd().endsWith("$0.0200")).toBe(true);
    expect(lines[0].length).toBe(64);
    expect(lines[1]).toContain("2.1s");
    expect(lines[1].trimEnd().endsWith("$0.0200")).toBe(true);
  });

  it("folds repairs (⟳n) and an open-span ellipsis into the label", () => {
    const open: AgentEvent[] = [
      { type: "span_start", span: "s", name: "audit", kind: "turn" },
      { type: "repair", span: "s", attempt: 1 },
    ];
    const out = renderRunTree(buildRunTree(open), { width: 40, color: false });
    expect(out).toContain("audit ⟳1 …");
  });

  it("truncates an overflowing label instead of breaking the layout", () => {
    const long: AgentEvent[] = [
      { type: "span_start", span: "s", name: "x".repeat(200), kind: "turn" },
      { type: "span_end", span: "s", durationMs: 5, usage: u(1, 0) },
    ];
    const out = renderRunTree(buildRunTree(long), { width: 40, color: false });
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain("5ms");
  });
});
