// Render a run's span tree into the CLI's text panel. Two halves in one file:
// shaping (the tree walk → flat, ordered rows with label/metric strings, no
// color) and painting (rows → a multi-line string: ANSI by span kind, right-
// aligned metrics, label truncation on overflow). No IO, no live redraw here;
// `panel.ts` drives the redraw, this turns a tree snapshot into text. The tree
// itself comes from `@microfoom/core/trace` (buildRunTree).
//
//   ▼ main                                12.4s  21tok  $0.21
//     ▸ discoverRoutes                     2.1s   2tok  $0.02
//     ▼ audit  routes=3                    7.8s  16tok  $0.16
//       ▸ /login                           2.0s   5tok  $0.05
//       • 3 routes audited

import type { RunNode } from "@microfoom/core/trace";
import cliTruncate from "cli-truncate";
import pc from "picocolors";
import stringWidth from "string-width";
import { fmtCost, fmtDuration, fmtTokens } from "./format.js";

// --- shaping: span tree → ordered rows -------------------------------------

/** A span node, flattened: label/metrics precomputed, depth for indentation. */
interface TraceSpanRow {
  readonly type: "span";
  readonly depth: number;
  /** `▼` when the span has children, `▸` when it is a leaf. */
  readonly glyph: "▼" | "▸";
  readonly kind: RunNode["kind"];
  /** name + `k=v` annotations + `⟳n` repairs + ` …` while still open. */
  readonly label: string;
  /** `12.4s  21tok  $0.21` (cost omitted when underivable). */
  readonly metrics: string;
}

/** A log line attached to a span, emitted after that span's child rows. */
interface TraceLogRow {
  readonly type: "log";
  readonly depth: number;
  readonly message: string;
  readonly level: "info" | "warn" | "error";
}

type TraceRow = TraceSpanRow | TraceLogRow;

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
  });
  for (const child of node.children) pushNode(child, depth + 1, out);
  // Logs render after children, matching how the events landed in time.
  for (const log of node.logs) {
    out.push({ type: "log", depth, message: log.message, level: log.level });
  }
}

function rowsOf(root: RunNode): TraceRow[] {
  const out: TraceRow[] = [];
  pushNode(root, 0, out);
  return out;
}

// --- painting: rows → a colored, width-aligned panel string ----------------

export interface RenderOptions {
  /** Terminal width to right-align metrics to. Default 80. */
  readonly width?: number;
  /** Emit ANSI color. Default false (so snapshots stay plain). */
  readonly color?: boolean;
}

const glyphColor: Record<TraceSpanRow["kind"], (s: string) => string> = {
  program: pc.bold,
  method: pc.cyan,
  turn: pc.green,
  scope: pc.yellow,
};

function renderSpan(row: TraceSpanRow, width: number, color: boolean): string {
  const indent = "  ".repeat(row.depth);
  const left = `${indent}${row.glyph} ${row.label}`;
  const right = row.metrics;

  // Reserve the right column; truncate the label if the row would overflow.
  const budget = Math.max(0, width - stringWidth(right) - 1);
  const leftFit = stringWidth(left) > budget ? cliTruncate(left, budget) : left;
  const gap = Math.max(1, width - stringWidth(leftFit) - stringWidth(right));
  const rightOut = color ? pc.dim(right) : right;
  const leftOut = color ? `${indent}${glyphColor[row.kind](row.glyph)} ${row.label}` : leftFit;
  // When colored we skip truncation styling math on the colored copy; plain path
  // (snapshots/tests) is width-exact.
  return color ? `${leftOut}${" ".repeat(gap)}${rightOut}` : `${leftFit}${" ".repeat(gap)}${right}`;
}

/** Render a run tree snapshot to a panel string. */
export function renderRunTree(root: RunNode, options: RenderOptions = {}): string {
  const width = options.width ?? 80;
  const color = options.color ?? false;
  const out: string[] = [];
  for (const row of rowsOf(root)) {
    if (row.type === "span") {
      out.push(renderSpan(row, width, color));
      continue;
    }
    const line = `${"  ".repeat(row.depth)}   • ${row.message}`;
    out.push(color && row.level !== "info" ? pc.dim(line) : line);
  }
  return out.join("\n");
}
