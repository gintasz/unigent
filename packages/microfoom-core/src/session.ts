// Harness session port + turn coordinator (ADR-0002, revised). The harness owns
// the model loop and EXECUTES the FOOM tools (pi runs them; the faux replays
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
  /** When true, the turn should stop after this tool (a terminal FOOMRETURN/THROW). */
  readonly terminate?: boolean;
}

/** A tool the harness advertises and executes. Core owns `execute` (the semantics). */
export interface NeutralToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
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

/** Incremental output during a turn (token streaming surfaced to onToken). */
export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string };

/** One model turn for the harness to run: prompt + the tools it may call. */
export interface SessionTurnRequest {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly tools: readonly NeutralToolDef[];
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
}

/** A harness opens one session per program run, given the run's model + caps. */
export interface HarnessSessionOptions {
  readonly model: string;
}

/** Factory the runner calls to open a session for a program run. */
export type OpenSession = (
  options: HarnessSessionOptions,
) => Promise<HarnessSession> | HarnessSession;
