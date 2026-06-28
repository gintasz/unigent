// Tiny pure formatters for the run panel and footer. Kept apart so they are
// trivially unit-testable (no ANSI, no IO).

import type { AgentUsage } from "@microfoom/core/trace";

/** Human duration, no milliseconds, rolling into minutes and hours:
 *  `—` when open, `<1s`, `42s`, `3m 07s`, `1h 05m`. */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 1) return "<1s";
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Cost: empty when underivable; more precision for sub-cent amounts. */
export function fmtCost(costUsd: number | undefined): string {
  if (costUsd === undefined) return "";
  return `$${costUsd < 0.1 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
}

/** Token count, compact: raw under 1k, `68.9ktok` to 100k, `0.6Mtok` above —
 *  so large totals stay short (620816 → `0.6Mtok`, 100000 → `0.1Mtok`). */
export function fmtTokens(total: number): string {
  if (total >= 100_000) return `${(total / 1_000_000).toFixed(1)}Mtok`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}ktok`;
  return `${total}tok`;
}

/** One-line run summary for the footer (stderr). */
export function fmtSummary(usage: AgentUsage, durationMs: number | undefined): string {
  const parts = [fmtDuration(durationMs), fmtTokens(usage.totalTokens)];
  const cost = fmtCost(usage.costUsd);
  if (cost.length > 0) parts.push(cost);
  if (usage.calls > 0) parts.push(`${usage.calls} call${usage.calls === 1 ? "" : "s"}`);
  return parts.join("  ");
}
