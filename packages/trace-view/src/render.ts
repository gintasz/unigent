// Frontend-neutral shaping of a run's span tree into flat, ordered rows. This is
// the shared half of trace presentation: it builds the label and metric strings
// once (so the CLI text panel and the pi TUI widget never drift), but paints
// nothing — no ANSI, no width alignment, no Component. Each frontend turns these
// rows into its own surface (picocolors + log-update for the CLI; Box/Text +
// theme for pi). The tree itself comes from `@microfoom/core/trace` (buildRunTree).
//
//   ▼ main                    ← span row, depth 0
//     ▸ discoverRoutes        ← span row, depth 1
//     ▼ audit  routes=3 ⟳1    ← span row, depth 1 (annotations + repairs folded in)
//       • 3 routes audited     ← log row, depth 1 (logs follow their span's children)

import type { RunNode } from "@microfoom/core/trace";
import { fmtCost, fmtDuration, fmtTokens } from "./format.js";

/** A span node, flattened: label/metrics precomputed, depth for indentation. */
export interface TraceSpanRow {
  readonly type: "span";
  readonly depth: number;
  /** `▼` when the span has children, `▸` when it is a leaf. */
  readonly glyph: "▼" | "▸";
  readonly kind: RunNode["kind"];
  /** name + `k=v` annotations + `⟳n` repairs + ` …` while still open. */
  readonly label: string;
  /** `12.4s  21tok  $0.21` (cost omitted when underivable). */
  readonly metrics: string;
  /** True while the span has not settled (still running). */
  readonly open: boolean;
}

/** A log line attached to a span, emitted after that span's child rows. */
export interface TraceLogRow {
  readonly type: "log";
  readonly depth: number;
  readonly message: string;
  readonly level: "info" | "warn" | "error";
}

export type TraceRow = TraceSpanRow | TraceLogRow;

function labelOf(node: RunNode): string {
  let label = node.name;
  const entries = Object.entries(node.annotations);
  if (entries.length > 0) label += `  ${entries.map(([k, v]) => `${k}=${String(v)}`).join(" ")}`;
  if (node.repairs > 0) label += ` ⟳${node.repairs}`;
  if (!node.settled) label += " …";
  return label;
}

function metricsOf(node: RunNode): string {
  const parts = [fmtDuration(node.durationMs), fmtTokens(node.usage.totalTokens)];
  const cost = fmtCost(node.usage.costUsd);
  if (cost.length > 0) parts.push(cost);
  return parts.join("  ");
}

function pushNode(node: RunNode, depth: number, out: TraceRow[]): void {
  out.push({
    type: "span",
    depth,
    glyph: node.children.length > 0 ? "▼" : "▸",
    kind: node.kind,
    label: labelOf(node),
    metrics: metricsOf(node),
    open: !node.settled,
  });
  for (const child of node.children) pushNode(child, depth + 1, out);
  // Logs render after children, matching how the events landed in time.
  for (const log of node.logs) {
    out.push({ type: "log", depth, message: log.message, level: log.level });
  }
}

/** Flatten a run tree into ordered presentation rows (span rows + log rows). */
export function renderRows(root: RunNode): TraceRow[] {
  const out: TraceRow[] = [];
  pushNode(root, 0, out);
  return out;
}
