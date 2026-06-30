// Tiny pure formatters for the run panel and footer. Kept apart so they are
// trivially unit-testable (no ANSI, no IO).

import type { AgentUsage } from "@microfoom/core/trace";

const MS_PER_SEC = 1000;
const SEC_PER_HOUR = 3600;
const SEC_PER_MIN = 60;
const SUB_CENT_THRESHOLD_USD = 0.1;
const SUB_CENT_DECIMALS = 4;
const TOKENS_MEGA_THRESHOLD = 100_000;
const TOKENS_PER_MEGA = 1_000_000;
const TOKENS_PER_KILO = 1000;

/** Human duration, no milliseconds, rolling into minutes and hours:
 *  `—` when open, `<1s`, `42s`, `3m 07s`, `1h 05m`. */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return "—";
  }
  const totalSec = Math.round(ms / MS_PER_SEC);
  if (totalSec < 1) {
    return "<1s";
  }
  const hours = Math.floor(totalSec / SEC_PER_HOUR);
  const minutes = Math.floor((totalSec % SEC_PER_HOUR) / SEC_PER_MIN);
  const seconds = totalSec % SEC_PER_MIN;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

/** Cost: empty when underivable; more precision for sub-cent amounts. */
export function fmtCost(costUsd: number | undefined): string {
  if (costUsd === undefined) {
    return "";
  }
  return `$${costUsd < SUB_CENT_THRESHOLD_USD ? costUsd.toFixed(SUB_CENT_DECIMALS) : costUsd.toFixed(2)}`;
}

/** Token count, compact: raw under 1k, `68.9ktok` to 100k, `0.6Mtok` above —
 *  so large totals stay short (620816 → `0.6Mtok`, 100000 → `0.1Mtok`). */
export function fmtTokens(total: number): string {
  if (total >= TOKENS_MEGA_THRESHOLD) {
    return `${(total / TOKENS_PER_MEGA).toFixed(1)}Mtok`;
  }
  if (total >= TOKENS_PER_KILO) {
    return `${(total / TOKENS_PER_KILO).toFixed(1)}ktok`;
  }
  return `${total}tok`;
}

/** One-line run summary for the footer (stderr). */
export function fmtSummary(usage: AgentUsage, durationMs: number | undefined): string {
  const parts = [fmtDuration(durationMs), fmtTokens(usage.totalTokens)];
  const cost = fmtCost(usage.costUsd);
  if (cost.length > 0) {
    parts.push(cost);
  }
  return parts.join("  ");
}
