// CLI text painter: turns the frontend-neutral trace rows (@microfoom/trace-view)
// into a multi-line string panel — ANSI color by span kind, right-aligned metrics,
// label truncation when a row would overflow the terminal width. The row shaping
// (tree walk, labels, metric strings) lives in trace-view so the pi TUI widget
// renders the identical data; this file owns only the CLI's paint. No IO, no live
// redraw here; `panel.ts` drives the redraw, this turns a tree snapshot into text.
//
//   ▼ main                                12.4s  21tok  $0.21
//     ▸ discoverRoutes                     2.1s   2tok  $0.02
//     ▼ audit  routes=3                    7.8s  16tok  $0.16
//       ▸ /login                           2.0s   5tok  $0.05
//       • 3 routes audited

import type { RunNode } from "@microfoom/core/trace";
import { renderRows, type TraceSpanRow } from "@microfoom/trace-view";
import cliTruncate from "cli-truncate";
import pc from "picocolors";
import stringWidth from "string-width";

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
  for (const row of renderRows(root)) {
    if (row.type === "span") {
      out.push(renderSpan(row, width, color));
      continue;
    }
    const line = `${"  ".repeat(row.depth)}   • ${row.message}`;
    out.push(color && row.level !== "info" ? pc.dim(line) : line);
  }
  return out.join("\n");
}
