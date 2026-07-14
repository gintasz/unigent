import type { AgentUsage } from "@unigent/core";

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const TOKENS_PER_KILO = 1000;
const SUB_CENT_THRESHOLD_USD = 0.1;
const SUB_CENT_DECIMALS = 4;
const STANDARD_COST_DECIMALS = 2;

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) {
    return "—";
  }
  const seconds = Math.round(milliseconds / MILLISECONDS_PER_SECOND);
  if (seconds < 1) {
    return "<1s";
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return `${minutes}m ${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}s`;
}

function formatTokens(tokens: number): string {
  return tokens < TOKENS_PER_KILO ? `${tokens}tok` : `${(tokens / TOKENS_PER_KILO).toFixed(1)}ktok`;
}

function formatCost(costUsd: number | undefined): string {
  return costUsd === undefined
    ? ""
    : `$${costUsd.toFixed(costUsd < SUB_CENT_THRESHOLD_USD ? SUB_CENT_DECIMALS : STANDARD_COST_DECIMALS)}`;
}

function formatUsage(usage: AgentUsage): string {
  const parts = [formatTokens(usage.totalTokens)];
  const cost = formatCost(usage.costUsd);
  if (cost.length > 0) {
    parts.push(cost);
  }
  return parts.join("  ");
}

export { formatCost, formatDuration, formatTokens, formatUsage };
