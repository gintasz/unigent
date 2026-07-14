import type { BackendUsage } from "./backend.js";

/** Immutable usage snapshot. */
interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
  readonly calls: number;
}

/** Create an empty usage value. */
function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
}

function combineCost(left: AgentUsage, right: AgentUsage): number | undefined {
  if (left.calls === 0) {
    return right.costUsd;
  }
  if (right.calls === 0) {
    return left.costUsd;
  }
  if (left.costUsd === undefined || right.costUsd === undefined) {
    return;
  }
  return left.costUsd + right.costUsd;
}

/** Associatively combine usage without double counting. */
function combineUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  const cachedInputTokens = (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0);
  const reasoningTokens = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0);
  const costUsd = combineCost(left, right);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    calls: left.calls + right.calls,
    ...(cachedInputTokens === 0 ? {} : { cachedInputTokens }),
    ...(reasoningTokens === 0 ? {} : { reasoningTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/** Convert a backend delta to the public immutable shape. */
function usageFromBackend(usage: BackendUsage): AgentUsage {
  return { ...usage, calls: 1 };
}

/** Mutable single-writer usage account. */
class UsageAccount {
  private current: AgentUsage = emptyUsage();

  public add(usage: AgentUsage): void {
    this.current = combineUsage(this.current, usage);
  }

  public snapshot(): AgentUsage {
    return { ...this.current };
  }
}

export type { AgentUsage };
export { combineUsage, emptyUsage, UsageAccount, usageFromBackend };
