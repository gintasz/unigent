import type { AgentUsage } from "@unigent/core";
import type { TraceNode, TraceTree } from "@unigent/core/trace";
import { describe, expect, it } from "vitest";
import {
  diagnosticsForRow,
  environmentLabel,
  flattenTraceTree,
  focusLabel,
} from "../src/tui/tree.ts";

const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };

function node(
  spanId: string,
  name: string,
  kind: "run" | "tool",
  children: readonly TraceNode[] = [],
): TraceNode {
  return {
    traceId: "trace",
    spanId,
    parentSpanId: undefined,
    name,
    kind,
    backend: "fake",
    model: "fake",
    agent: name,
    scopePath: [],
    durationMs: 1,
    usage,
    outcome: "succeeded",
    error: undefined,
    repairs: 0,
    logs: [],
    annotations: [],
    checkpoints: [],
    children,
  };
}

describe("trace tree presentation", () => {
  it("collapses repeated tools and promotes nested agents by default", () => {
    const nested = node("nested", "nested-agent", "run");
    const root = node("root", "parent", "run", [
      node("rate-1", "rate", "tool"),
      node("rate-2", "rate", "tool", [nested]),
      node("save", "save", "tool"),
    ]);
    const tree: TraceTree = { roots: [root], usage, durationMs: 1 };

    const rows = flattenTraceTree(tree);

    expect(rows.map((row) => row.name)).toEqual(["parent", "nested-agent"]);
    expect(rows[0]?.toolSummary).toBe("tools  rate ×2 · save");
  });

  it("expands tools only for the selected run and keeps them non-selectable", () => {
    const root = node("root", "parent", "run", [node("rate", "rate", "tool")]);
    const tree: TraceTree = { roots: [root], usage, durationMs: 1 };

    const rows = flattenTraceTree(tree, new Set(["root"]));

    expect(rows.map((row) => row.name)).toEqual(["parent", "rate"]);
    expect(rows[1]?.selectable).toBe(false);
    expect(rows[0]?.toolsExpanded).toBe(true);
  });

  it("projects scope paths into an aggregated workflow hierarchy", () => {
    const first = {
      ...node("first", "angle-0", "run"),
      agent: "pitch-writer",
      scopePath: ["pitch", "ranking", "angle-0"],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001, calls: 1 },
    } satisfies TraceNode;
    const second = {
      ...node("second", "angle-1", "run"),
      agent: "pitch-writer",
      scopePath: ["pitch", "ranking", "angle-1"],
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUsd: 0.002, calls: 1 },
    } satisfies TraceNode;
    const tree: TraceTree = { roots: [first, second], usage, durationMs: 1 };

    const rows = flattenTraceTree(tree);

    expect(rows.map((row) => row.name)).toEqual([
      "pitch",
      "ranking",
      "angle-0",
      "pitch-writer",
      "angle-1",
      "pitch-writer",
    ]);
    expect(rows[0]).toMatchObject({ kind: "scope", metrics: "2 runs  45tok  $0.0030" });
    expect(rows[1]?.prefix).toBe("└─ ");
    expect(rows[2]?.prefix).toBe("   ├─ ");
    expect(rows[0]?.selectedSpanIds).toEqual(["first", "second"]);
    expect(focusLabel(rows[1])).toBe("pitch/ranking");
  });

  it("summarizes heterogeneous environments honestly and narrows on focus", () => {
    const pi = { ...node("pi", "writer", "run"), backend: "pi", model: "fast" };
    const claude = {
      ...node("claude", "reviewer", "run"),
      backend: "claude-cli",
      model: "strong",
    };
    const tree: TraceTree = { roots: [pi, claude], usage, durationMs: 1 };
    const rows = flattenTraceTree(tree);

    expect(environmentLabel(tree)).toBe("2 backends · 2 models");
    expect(environmentLabel(tree, rows[0])).toBe("pi/fast");
  });

  it("retains logs, annotations, checkpoints, repairs, and failures for focused details", () => {
    const root = {
      ...node("root", "ranking", "run"),
      agent: "pitch-writer",
      scopePath: ["pitch", "ranking"],
      repairs: 2,
      logs: [{ level: "info", message: "best angle scored 92" }],
      annotations: [{ angleCount: 4 }],
      checkpoints: [{ action: "hit", key: "checkpoint-key" }],
      error: "provider stopped",
      outcome: "failed",
    } satisfies TraceNode;
    const tree: TraceTree = { roots: [root], usage, durationMs: 1 };
    const [scope] = flattenTraceTree(tree);
    if (scope === undefined) {
      throw new Error("scope row missing");
    }

    expect(diagnosticsForRow(scope)).toEqual([
      { kind: "repair", label: "pitch/ranking · repairs", value: "2 repair attempts" },
      { kind: "log", label: "pitch/ranking · info", value: "best angle scored 92" },
      { kind: "annotation", label: "pitch/ranking · annotation", value: { angleCount: 4 } },
      {
        kind: "checkpoint",
        label: "pitch/ranking · checkpoint hit",
        value: "checkpoint-key",
      },
      { kind: "error", label: "pitch/ranking · error", value: "provider stopped" },
    ]);
  });
});
