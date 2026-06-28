// Agent run configuration and its scoped cascade (F5). Config cascades widest →
// narrowest (harness default → class → method → per-call), merging by a rule
// fixed per option kind:
//   - caps (max*) TIGHTEN-ONLY: effective = the tighter (min) of inherited/override.
//   - systemPrompt COMPOSES: `append` accumulates, `replace` resets the base.
//   - everything else OVERRIDES: nearest scope wins.
// The merge here is pure and total; an unenforceable cap (F5) is rejected later,
// at engine setup, through the typed error channel — not in this module.

/** A wall-clock duration literal: seconds, minutes, or hours. */
export type Duration = `${number}s` | `${number}m` | `${number}h`;

/** Reasoning effort. Known levels plus provider-passthrough raw strings. */
export type ThinkingLevel = "low" | "medium" | "high" | (string & {});

/**
 * System-prompt contribution for one scope. Exactly one of `append` / `replace`:
 * `append` accumulates onto the inherited prompt; `replace` discards everything
 * from wider scopes and becomes the new base.
 */
export type SystemPrompt = { append: string } | { replace: string };

/** Scoped agent configuration. Every field optional; absence means "inherit". */
export interface AgentConfig {
  // --- override: closest scope wins ---
  /**
   * Model id the agent runs on, as `"provider/id"` (e.g.
   * `"openrouter/deepseek/deepseek-v4-flash"`). Opaque to the core — the harness
   * resolves it. No built-in default: a turn with no model in any scope is a
   * {@link FoomtimeConfigError}.
   */
  model?: string;
  /** Which registered harness runs this scope's agent turns. An opaque key into
   *  the run's harness registry (resolved at session-open), so the generic core
   *  never names a concrete adapter. */
  harness?: string;
  /** The harness tools the model may use this scope (opaque names the harness
   *  resolves; core never enumerates them). `undefined` = all the harness offers;
   *  `[]` = none; a list = only those. The FOOM protocol tools are always available
   *  regardless — this gates only the harness's own tools, per turn. */
  tools?: readonly string[];
  /** The skills the harness advertises to the model this scope (opaque names the
   *  harness resolves). `undefined` = all the harness discovers; `[]` = none; a list
   *  = only those. Session-level for a stateful session (fixed at open); per-scope
   *  for stateless turns (each opens a fresh session). */
  skills?: readonly string[];
  /** The plugins the harness loads this scope (pi calls these "extensions"; opaque
   *  names). Same tri-state + session timing as {@link AgentConfig.skills}. */
  plugins?: readonly string[];
  /** Reasoning effort for the turn. One of the known {@link ThinkingLevel}s, or a
   *  provider-specific raw string passed through untouched. Absent = inherit (and,
   *  at the widest scope, whatever the harness/model defaults to). */
  thinking?: ThinkingLevel;
  /** How many times the harness may retry a turn that fails with a *retryable*
   *  harness error ({@link FoomtimeHarnessUnavailableError}). Absent = the harness's
   *  own default. Does not apply to validation failures — those use
   *  {@link AgentConfig.repairAttempts}. */
  retries?: number;
  /** Consecutive validation failures tolerated before the turn gives up with
   *  {@link FoomtimeRepairExhaustedError}. Each bad `foom_call`/`foom_return` is fed
   *  back to the model as a repair hint and counts toward this budget.
   *  @defaultValue `3` */
  repairAttempts?: number;
  // --- compose: append accumulates, replace resets ---
  /** This scope's contribution to the system prompt. {@link SystemPrompt} is either
   *  `{ append }` (accumulates onto wider scopes) or `{ replace }` (discards them
   *  and becomes the new base). */
  systemPrompt?: SystemPrompt;
  // --- cap: tightens only, never loosens ---
  /** Hard ceiling on run cost in USD; exceeding it aborts with
   *  {@link FoomtimeBudgetExceededError}. Tighten-only across the cascade — a
   *  narrower scope can lower it, never raise it. Absent = uncapped. */
  maxBudgetUsd?: number;
  /** Hard ceiling on output tokens; exceeding it aborts with
   *  {@link FoomtimeTokenLimitExceededError}. Tighten-only. Absent = uncapped. */
  maxOutputTokens?: number;
  /** Maximum nesting depth of `foom_call` re-entry; exceeding it aborts with
   *  {@link FoomtimeCallDepthError}. Tighten-only. Absent = uncapped. */
  maxCallDepth?: number;
  /** Wall-clock ceiling on a single turn (a {@link Duration} like `"30s"`);
   *  exceeding it aborts with {@link FoomtimeTimeoutError}. Tighten-only.
   *  Absent = uncapped. */
  maxTurnDuration?: Duration;
}

const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h)$/;

/**
 * Parse a Duration literal to milliseconds. Returns undefined for a malformed
 * string so callers can reject it through the typed error channel rather than
 * trusting a silent NaN.
 */
export function durationToMs(duration: Duration): number | undefined {
  const match = DURATION_PATTERN.exec(duration);
  if (!match) return undefined;
  const [, value, unit] = match;
  if (value === undefined || unit === undefined) return undefined;
  return Number(value) * DURATION_UNIT_MS[unit as keyof typeof DURATION_UNIT_MS];
}

/**
 * The tighter (shorter) of two durations; malformed inputs defer to the valid
 * one. Ties (equal ms, different spelling like `60s`/`1m`) break by string order
 * so the result is independent of argument order — keeping the cascade merge
 * associative (Q6).
 */
function minDuration(wider: Duration, narrower: Duration): Duration {
  const a = durationToMs(wider);
  const b = durationToMs(narrower);
  if (a === undefined) return narrower;
  if (b === undefined) return wider;
  if (b < a) return narrower;
  if (a < b) return wider;
  return wider <= narrower ? wider : narrower;
}

/** The tighter (smaller) of two numeric caps. */
function minCap(wider: number, narrower: number): number {
  return Math.min(wider, narrower);
}

/** narrower wins when present; otherwise inherit the wider value. */
function override<T>(wider: T | undefined, narrower: T | undefined): T | undefined {
  return narrower !== undefined ? narrower : wider;
}

/** Tightening cap merge: defined-and-tighter wins; undefined inherits. */
function mergeCap(wider: number | undefined, narrower: number | undefined): number | undefined {
  if (wider === undefined) return narrower;
  if (narrower === undefined) return wider;
  return minCap(wider, narrower);
}

/**
 * Compose two system-prompt contributions (wider then narrower). A `replace` at
 * the narrower scope discards the wider; an `append` folds onto the wider,
 * collapsing into a single `replace` when the wider already established a base.
 */
function mergeSystemPrompt(
  wider: SystemPrompt | undefined,
  narrower: SystemPrompt | undefined,
): SystemPrompt | undefined {
  if (narrower === undefined) return wider;
  if ("replace" in narrower) return narrower;
  // narrower is an append.
  if (wider === undefined) return narrower;
  if ("replace" in wider) return { replace: `${wider.replace}\n${narrower.append}` };
  return { append: `${wider.append}\n${narrower.append}` };
}

/** Every field present but possibly undefined — the shape merge produces before compaction. */
type LooseConfig = { [K in keyof AgentConfig]-?: AgentConfig[K] | undefined };

/** Build an object with only the defined fields (respects exactOptionalPropertyTypes). */
function compact(config: LooseConfig): AgentConfig {
  const out: AgentConfig = {};
  if (config.model !== undefined) out.model = config.model;
  if (config.harness !== undefined) out.harness = config.harness;
  if (config.tools !== undefined) out.tools = config.tools;
  if (config.skills !== undefined) out.skills = config.skills;
  if (config.plugins !== undefined) out.plugins = config.plugins;
  if (config.thinking !== undefined) out.thinking = config.thinking;
  if (config.retries !== undefined) out.retries = config.retries;
  if (config.repairAttempts !== undefined) out.repairAttempts = config.repairAttempts;
  if (config.systemPrompt !== undefined) out.systemPrompt = config.systemPrompt;
  if (config.maxBudgetUsd !== undefined) out.maxBudgetUsd = config.maxBudgetUsd;
  if (config.maxOutputTokens !== undefined) out.maxOutputTokens = config.maxOutputTokens;
  if (config.maxCallDepth !== undefined) out.maxCallDepth = config.maxCallDepth;
  if (config.maxTurnDuration !== undefined) out.maxTurnDuration = config.maxTurnDuration;
  return out;
}

/**
 * Merge a wider scope's config with a narrower one. Associative, so folding a
 * chain in either grouping yields the same result (Q6). Pure and total.
 */
export function mergeConfig(wider: AgentConfig, narrower: AgentConfig): AgentConfig {
  const merged: LooseConfig = {
    model: override(wider.model, narrower.model),
    harness: override(wider.harness, narrower.harness),
    tools: override(wider.tools, narrower.tools),
    skills: override(wider.skills, narrower.skills),
    plugins: override(wider.plugins, narrower.plugins),
    thinking: override(wider.thinking, narrower.thinking),
    retries: override(wider.retries, narrower.retries),
    repairAttempts: override(wider.repairAttempts, narrower.repairAttempts),
    systemPrompt: mergeSystemPrompt(wider.systemPrompt, narrower.systemPrompt),
    maxBudgetUsd: mergeCap(wider.maxBudgetUsd, narrower.maxBudgetUsd),
    maxOutputTokens: mergeCap(wider.maxOutputTokens, narrower.maxOutputTokens),
    maxCallDepth: mergeCap(wider.maxCallDepth, narrower.maxCallDepth),
    maxTurnDuration:
      wider.maxTurnDuration === undefined
        ? narrower.maxTurnDuration
        : narrower.maxTurnDuration === undefined
          ? wider.maxTurnDuration
          : minDuration(wider.maxTurnDuration, narrower.maxTurnDuration),
  };
  return compact(merged);
}

/** Fold a widest-to-narrowest chain of scopes into one effective config. */
export function mergeConfigChain(scopes: readonly AgentConfig[]): AgentConfig {
  return scopes.reduce<AgentConfig>((acc, scope) => mergeConfig(acc, scope), {});
}
