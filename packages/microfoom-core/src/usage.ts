// Run accounting (OB3). Usage accumulates as a monoid — an empty value and an
// associative combine — folded once, never hand-summed at call sites. The internal
// carrier `UsageAccount` has every accounting field present (cost/optional token
// counts as `number | undefined`); the public `AgentUsage` is its compacted
// projection plus live timestamps (T5). Plain functions: the combine
// is small and its laws are pinned by property tests.

/**
 * Cumulative usage, as read by a consumer. A live sync snapshot — grows as turns
 * settle, final once the run/session/turn ends. Optional fields are absent when
 * the provider does not report them; `costUsd` is absent when pricing is
 * underivable (and then a cost cap fails fast at setup — F5).
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  calls: number;
  maxCallDepth: number;
  startedAt?: Date;
  updatedAt?: Date;
  durationMs?: number;
}

/** Internal accounting carrier — the monoid operates on this (no timestamps). */
export interface UsageAccount {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number | undefined;
  cachedInputTokens: number | undefined;
  costUsd: number | undefined;
  calls: number;
  maxCallDepth: number;
}

/** The zero account — identity of `combineUsage`. */
export const emptyUsage: UsageAccount = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: undefined,
  cachedInputTokens: undefined,
  costUsd: 0,
  calls: 0,
  maxCallDepth: 0,
};

// undefined means "not reported": sum reported values; stay undefined only when
// neither side reported. (Identity: undefined.)
function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

// cost is absorbing: one underivable turn cost makes the total underivable.
// (Identity: 0 — a known-zero cost.)
function addCost(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : a + b;
}

/** Combine two accounts. Associative, with `emptyUsage` as identity (Q6). */
export function combineUsage(a: UsageAccount, b: UsageAccount): UsageAccount {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: addOptional(a.reasoningTokens, b.reasoningTokens),
    cachedInputTokens: addOptional(a.cachedInputTokens, b.cachedInputTokens),
    costUsd: addCost(a.costUsd, b.costUsd),
    calls: a.calls + b.calls,
    maxCallDepth: Math.max(a.maxCallDepth, b.maxCallDepth),
  };
}

/** One harness-reported turn (delta) as an account: one call, at the given depth. */
export function accountFromDelta(
  delta: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
    readonly costUsd?: number;
  },
  depth: number,
): UsageAccount {
  return {
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    totalTokens: delta.totalTokens,
    reasoningTokens: delta.reasoningTokens,
    cachedInputTokens: delta.cachedInputTokens,
    costUsd: delta.costUsd,
    calls: 1,
    maxCallDepth: depth,
  };
}

/** Optional timestamps/duration the runtime stamps onto the projected usage. */
export interface UsageTimes {
  startedAt?: Date;
  updatedAt?: Date;
  durationMs?: number;
}

/** Project the internal account to the public, compacted AgentUsage (T5). */
export function toAgentUsage(account: UsageAccount, times?: UsageTimes): AgentUsage {
  const usage: AgentUsage = {
    inputTokens: account.inputTokens,
    outputTokens: account.outputTokens,
    totalTokens: account.totalTokens,
    calls: account.calls,
    maxCallDepth: account.maxCallDepth,
  };
  if (account.reasoningTokens !== undefined) usage.reasoningTokens = account.reasoningTokens;
  if (account.cachedInputTokens !== undefined) usage.cachedInputTokens = account.cachedInputTokens;
  if (account.costUsd !== undefined) usage.costUsd = account.costUsd;
  if (times?.startedAt !== undefined) usage.startedAt = times.startedAt;
  if (times?.updatedAt !== undefined) usage.updatedAt = times.updatedAt;
  if (times?.durationMs !== undefined) usage.durationMs = times.durationMs;
  return usage;
}
