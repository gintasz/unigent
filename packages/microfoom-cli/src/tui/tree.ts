// Pure shaping for the trace pane: flatten the run tree into clickable rows and
// resolve which spans belong under a selected node (so clicking a node filters the
// transcript to that subtree). No React, no color — trivially testable.

import type { RunNode } from "@microfoom/core/trace";
import { fmtCost, fmtDuration, fmtTokens } from "../format.js";

export interface TreeRow {
  readonly span: string;
  readonly name: string;
  readonly kind: RunNode["kind"];
  readonly depth: number;
  /** `▼` for a node with children, `▸` for a leaf. */
  readonly glyph: "▼" | "▸";
  /** `12.4s` / `21tok` style metric tail; empty when nothing to show. */
  readonly metrics: string;
  /** Whether the span is still open (drawn with a trailing marker). */
  readonly settled: boolean;
}

function metricsOf(node: RunNode): string {
  const parts: string[] = [];
  if (node.durationMs !== undefined) parts.push(fmtDuration(node.durationMs));
  if (node.usage.totalTokens > 0) parts.push(fmtTokens(node.usage.totalTokens));
  if (node.usage.costUsd !== undefined && node.usage.costUsd > 0)
    parts.push(fmtCost(node.usage.costUsd));
  return parts.join("  ");
}

/** Depth-first flatten of the run tree into ordered rows. */
export function flattenTree(root: RunNode): readonly TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (node: RunNode, depth: number): void => {
    out.push({
      span: node.span,
      name: node.name,
      kind: node.kind,
      depth,
      glyph: node.children.length > 0 ? "▼" : "▸",
      metrics: metricsOf(node),
      settled: node.settled,
    });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Span ids in the subtree rooted at `span` (inclusive). Empty if not found. */
export function subtreeSpans(root: RunNode, span: string): ReadonlySet<string> {
  const find = (node: RunNode): RunNode | undefined => {
    if (node.span === span) return node;
    for (const child of node.children) {
      const hit = find(child);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const target = find(root);
  const out = new Set<string>();
  if (target === undefined) return out;
  const collect = (node: RunNode): void => {
    out.add(node.span);
    for (const child of node.children) collect(child);
  };
  collect(target);
  return out;
}
