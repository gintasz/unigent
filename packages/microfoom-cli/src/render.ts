// Pure renderer: a RunNode tree → a multi-line string panel. Presentation only —
// this is the CLI's job, NOT the core's (core/trace ships the data, every frontend
// renders it for its own surface). No IO, no live redraw here; `panel.ts` drives
// the redraw, this just turns a tree snapshot into text.
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

export interface RenderOptions {
  /** Terminal width to right-align metrics to. Default 80. */
  readonly width?: number;
  /** Emit ANSI color. Default false (so snapshots stay plain). */
  readonly color?: boolean;
}

const glyphColor: Record<RunNode["kind"], (s: string) => string> = {
  program: pc.bold,
  method: pc.cyan,
  turn: pc.green,
  scope: pc.yellow,
};

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

function renderNode(
  node: RunNode,
  depth: number,
  width: number,
  color: boolean,
  out: string[],
): void {
  const indent = "  ".repeat(depth);
  const glyph = node.children.length > 0 ? "▼" : "▸";
  const left = `${indent}${glyph} ${labelOf(node)}`;
  const right = metricsOf(node);

  // Reserve the right column; truncate the label if the row would overflow.
  const budget = Math.max(0, width - stringWidth(right) - 1);
  const leftFit = stringWidth(left) > budget ? cliTruncate(left, budget) : left;
  const gap = Math.max(1, width - stringWidth(leftFit) - stringWidth(right));
  const rightOut = color ? pc.dim(right) : right;
  const leftOut = color ? `${indent}${glyphColor[node.kind](glyph)} ${labelOf(node)}` : leftFit;
  // When colored we skip truncation styling math on the colored copy; plain path
  // (snapshots/tests) is width-exact.
  out.push(
    color ? `${leftOut}${" ".repeat(gap)}${rightOut}` : `${leftFit}${" ".repeat(gap)}${right}`,
  );

  for (const log of node.logs) {
    const line = `${indent}   • ${log.message}`;
    out.push(color && log.level !== "info" ? pc.dim(line) : line);
  }
  for (const child of node.children) renderNode(child, depth + 1, width, color, out);
}

/** Render a run tree snapshot to a panel string. */
export function renderRunTree(root: RunNode, options: RenderOptions = {}): string {
  const width = options.width ?? 80;
  const color = options.color ?? false;
  const out: string[] = [];
  renderNode(root, 0, width, color, out);
  return out.join("\n");
}
