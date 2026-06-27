import { type AgentEvent, buildRunTree } from "@microfoom/core/trace";
import { describe, expect, it } from "vitest";
import { renderRows, type TraceSpanRow } from "../src/render.ts";

const u = (total: number, cost: number) => ({
  inputTokens: 0,
  outputTokens: total,
  totalTokens: total,
  costUsd: cost,
  calls: 1,
  maxCallDepth: 0,
});

describe("renderRows", () => {
  it("flattens span rows depth-first, with annotations and metrics folded in", () => {
    const events: AgentEvent[] = [
      { type: "span_start", span: "main", name: "main", kind: "program" },
      { type: "span_start", span: "t1", parent: "main", name: "discoverRoutes", kind: "turn" },
      { type: "annotate", span: "t1", attributes: { routes: 3 } },
      { type: "log", span: "t1", message: "3 routes audited", level: "info" },
      { type: "span_end", span: "t1", durationMs: 2100, usage: u(2, 0.02) },
      { type: "span_end", span: "main", durationMs: 12400, usage: u(0, 0) },
    ];
    const rows = renderRows(buildRunTree(events));

    // main (parent → ▼), then its child turn (leaf → ▸), then the child's log.
    expect(rows[0]).toMatchObject({ type: "span", depth: 0, glyph: "▼", label: "main" });
    expect((rows[0] as TraceSpanRow).metrics).toContain("12.4s");
    expect(rows[1]).toMatchObject({
      type: "span",
      depth: 1,
      glyph: "▸",
      label: "discoverRoutes  routes=3",
    });
    expect((rows[1] as TraceSpanRow).metrics).toContain("2.1s");
    expect(rows[2]).toMatchObject({ type: "log", depth: 1, message: "3 routes audited" });
  });

  it("marks an open span and folds repairs into its label", () => {
    const events: AgentEvent[] = [
      { type: "span_start", span: "s", name: "audit", kind: "turn" },
      { type: "repair", span: "s", attempt: 1 },
    ];
    const [row] = renderRows(buildRunTree(events)) as TraceSpanRow[];
    expect(row?.open).toBe(true);
    expect(row?.label).toBe("audit ⟳1 …");
  });
});
