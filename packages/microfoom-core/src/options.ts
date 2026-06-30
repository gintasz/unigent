// Public per-call / per-scope option types (the inputs to @foom.config, this.agent
// .with(), and a session's .with()). Config fields cascade (F5); hooks,
// cancellation, and turn metadata are per-call only.

import type { AgentConfig } from "./config.js";

/** A streamed token, surfaced to the onToken hook. */
export type LLMToken =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string };

/** Per-call runtime hooks (not part of the inheritable config cascade). */
export interface AgentRunHooks {
  onToken?: (token: LLMToken) => void;
}

/** Per-call cancellation. */
export interface AgentCancellation {
  signal?: AbortSignal;
}

/** Per-call display metadata. */
export interface AgentTurnMeta {
  /** Instrumentation label shown in the run panel/log instead of the raw prompt. */
  label?: string;
}

/**
 * Per-call turn-store controls (resume after termination). Apply only when a store
 * is configured on the run (`runProgram({ store })` / CLI `--store`); inert otherwise.
 */
export interface AgentStoreOptions {
  /**
   * Force this turn to a distinct store record. Two turns with the same prompt and
   * config hash to the same key and collapse to one stored result; set a different
   * `storeKey` on each (e.g. `"draft-0"`, `"draft-1"`) to keep deliberately-identical
   * turns — best-of-N sampling — as independent records.
   */
  storeKey?: string;
  /** Set to `false` to never store or recall this turn — always run it fresh, even
   *  on resume (for turns you want non-deterministic by design). */
  store?: false;
}

/** Everything accepted at a call/scope: cascading config plus per-call extras. */
export type AgentOptions = AgentConfig &
  AgentRunHooks &
  AgentCancellation &
  AgentTurnMeta &
  AgentStoreOptions;

/** Structured tool advertisement — the value of `@foom.expose({ tool })`. */
export interface AgentToolOptions {
  /** Human-readable description of what the tool does. */
  description?: string;
  /** Short snippet that may be inserted into the agent prompt/tool manifest. */
  promptSnippet?: string;
  /** Extra usage guidance for the agent. */
  promptGuidelines?: readonly string[];
}

/**
 * Exposure options. Three tiers by context cost (F3): bare (silent),
 * `{ announcement }` (named in the system prompt), `{ tool }` (native tool with
 * full param schema upfront).
 */
export interface AgentExposeOptions {
  /** Lightweight system-prompt mention so the agent is told the method exists. */
  announcement?: string;
  /** Advertise the method as a native structured tool. */
  tool?: AgentToolOptions;
}
