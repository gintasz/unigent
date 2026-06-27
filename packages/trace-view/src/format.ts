// Tiny pure formatters for run-trace presentation (panel rows + footer summary).
// Kept apart so they are trivially unit-testable (no ANSI, no IO). Shared by every
// frontend (CLI text panel, pi TUI widget) so duration/cost/token strings are
// identical across surfaces.

import type { AgentUsage } from "@microfoom/core/trace";

/** Human duration: `—` when open, `820ms` under a second, else `12.4s`. */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Cost: empty when underivable; more precision for sub-cent amounts. */
export function fmtCost(costUsd: number | undefined): string {
  if (costUsd === undefined) return "";
  return `$${costUsd < 0.1 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
}

/** Token count, compact. */
export function fmtTokens(total: number): string {
  return `${total}tok`;
}

/** One-line run summary for a footer/status line. */
export function fmtSummary(usage: AgentUsage, durationMs: number | undefined): string {
  const parts = [fmtDuration(durationMs), fmtTokens(usage.totalTokens)];
  const cost = fmtCost(usage.costUsd);
  if (cost.length > 0) parts.push(cost);
  if (usage.calls > 0) parts.push(`${usage.calls} call${usage.calls === 1 ? "" : "s"}`);
  return parts.join("  ");
}
