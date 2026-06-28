// Harness session port + turn coordinator (ADR-0002, revised). The harness owns
// the model loop and EXECUTES the FOOM tools (pi runs them; the fake replays
// them); core supplies the tool semantics (tools.ts) and this one thin
// coordinator that both share — so there is no duplicated loop. This is the
// Promise seam to an external agent (E1: foreign boundary); the pure domain
// (config, usage, validation) stays clear of this orchestration.

import type { ThinkingLevel } from "./config.js";

/** A JSON Schema object advertised to the model (derived, not authored — ADR-0003). */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Result of executing one tool call, returned to the harness loop. */
export interface ToolExecResult {
  /** Text returned to the model as the tool result. */
  readonly content: string;
  /** Whether this result is an error (the model should correct — repair). */
  readonly isError: boolean;
  /** When true, the turn should stop after this tool (a terminal `foom_return`/`foom_throw`). */
  readonly terminate?: boolean;
}

/** A tool the harness advertises and executes. Core owns `execute` (the semantics). */
export interface NeutralToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** Optional usage blurb (from @foom.expose({ tool }) or a control tool). A
   *  harness with a native slot uses it; one without (raw pi-agent-core) folds it
   *  into the model-visible description. `| undefined` so a sparse keyed map reads
   *  inline. */
  readonly promptSnippet?: string | undefined;
  /** Optional usage-rule bullets, presented like promptSnippet. */
  readonly promptGuidelines?: readonly string[] | undefined;
  readonly execute: (args: unknown) => Promise<ToolExecResult>;
}

/** Raw per-turn usage reported by the harness; folded into the usage Monoid. */
export interface UsageDelta {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costUsd?: number;
}

/**
 * Incremental output during a turn. `text`/`reasoning` are token deltas (surfaced
 * to onToken). The rest carry transcript structure a harness observes from its
 * model loop — assistant message boundaries and the tool calls it made — so a
 * frontend can show the live conversation. A harness emits what it can; a minimal
 * one emits only `text`.
 */
export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string }
  | { readonly type: "message_start" }
  | { readonly type: "message_end" }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly content: string;
      readonly isError: boolean;
    };

/** One model turn for the harness to run: prompt + the tools it may call. */
export interface SessionTurnRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly tools: readonly NeutralToolDef[];
  /** Allowlist of the harness's OWN tools to expose this turn (opaque names).
   *  `undefined` = all; `[]` = none. The `tools` above (FOOM) are always exposed. */
  readonly allowedTools?: readonly string[];
  readonly thinking?: ThinkingLevel;
  readonly maxOutputTokens?: number;
  readonly onEvent?: (event: StreamEvent) => void;
  readonly signal?: AbortSignal;
}

/** What the harness reports back once a turn settles. */
export interface SessionTurnResult {
  /** Final assistant prose for the turn (used by text turns). */
  readonly assistantText: string;
  readonly usage: UsageDelta;
}

/**
 * The PUBLIC harness contract (F6). A session runs one model turn:
 * it drives the model, executes the supplied tools (calling their `execute`), and
 * resolves when the turn settles (a tool signalled `terminate`, or the model
 * produced no tool call). Signal failures by throwing FoomtimeHarnessError
 * subclasses; honor `request.signal`.
 */
export interface HarnessSession {
  runTurn(request: SessionTurnRequest): Promise<SessionTurnResult>;
  /**
   * The full system prompt this session will actually send the model for a given
   * program prompt — e.g. a harness that prepends its own base prompt returns
   * `base + programPrompt`. For display/observability only (the runtime shows this
   * as the turn's system prompt); the same composition is applied inside runTurn.
   * Omit when the session sends the program prompt verbatim.
   */
  systemPrompt?(programPrompt: string): string;
  /**
   * Branch this session: return a NEW session seeded with a copy of the current
   * transcript, diverging independently from here (backs AgentSession.fork()).
   * Optional — a harness that can't clone its conversation state omits it, and
   * core's fork() then throws FoomtimeConfigError.
   */
  fork?(): HarnessSession;
}

/** A harness opens one session per program run, given the run's model + caps. */
export interface HarnessSessionOptions {
  readonly model: string;
  /** Skills to advertise this session (opaque names). `undefined` = all the harness
   *  discovers; `[]` = none; a list = only those. Resolved from the scope's merged
   *  config at open — see AgentConfig.skills. */
  readonly skills?: readonly string[];
  /** Plugins ("extensions" in pi) to load this session. Same tri-state as
   *  {@link HarnessSessionOptions.skills}. */
  readonly plugins?: readonly string[];
}

/** Factory the runner calls to open a session for a program run. */
export type OpenSession = (
  options: HarnessSessionOptions,
) => Promise<HarnessSession> | HarnessSession;
