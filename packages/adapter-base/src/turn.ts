// Stream→turn-result plumbing shared by the CLI harness adapters. Each adapter has
// its OWN stream parser (Claude Code's stream-json vs Codex's exec JSONL have
// different event shapes), but the surrounding mechanics are identical: drain the
// subprocess's JSONL stdout line-by-line into that parser tolerating noise, then map
// the parser's distilled state to a SessionTurnResult or the right typed error.

import {
  FoomHarnessRejectedError,
  FoomHarnessUnavailableError,
  type SessionTurnResult,
  type UsageDelta,
} from "@microfoom/core";
import type { Json } from "./json.js";

/** Why a turn ended badly (mapped to a FoomHarnessError by {@link resolveTurnResult}). */
export interface TurnError {
  readonly message: string;
  /** Whether retrying could plausibly succeed (transient model/network/rate-limit). */
  readonly retryable: boolean;
}

/** The minimal subprocess surface the drain/resolve helpers need. */
export interface TurnProcess {
  readonly lines: AsyncIterable<string>;
  /** Collected stderr (+ spawn error), available once `lines` is exhausted. */
  stderr: () => string;
}

/** The minimal reader surface {@link resolveTurnResult} reads a settled turn from. */
export interface TurnReaderState {
  /** A turn error if the model/CLI failed, else undefined. */
  error: () => TurnError | undefined;
  /** True once the terminal completion event was seen. */
  resultSeen: () => boolean;
  /** Final assistant prose for the turn. */
  assistantText: () => string;
  /** Accumulated usage for the turn. */
  usage: () => UsageDelta;
}

/** What an adapter's per-turn stream reader distils from the subprocess's JSONL: the
 *  settled-turn surface ({@link TurnReaderState}) plus the line sink and the session
 *  id captured for resume continuity. Each adapter builds its own (the event shapes
 *  differ); this is the shared shape `drainTurnStream`/`resolveTurnResult` consume. */
export interface TurnReader extends TurnReaderState {
  /** Feed one decoded JSONL object. */
  handle: (event: Json) => void;
  /** The session/thread id the CLI assigned (for resume continuity). */
  sessionId: () => string | undefined;
}

/** A zero usage delta — the reader's starting accumulator before any turn event. */
export const EMPTY_USAGE: UsageDelta = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Drain the subprocess's JSONL stdout into `handle`, tolerating non-JSON noise. */
export async function drainTurnStream(
  proc: TurnProcess,
  handle: (event: Json) => void,
): Promise<void> {
  for await (const line of proc.lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let event: Json;
    try {
      event = JSON.parse(trimmed) as Json;
    } catch {
      continue; // tolerate any non-JSON noise on the stream
    }
    handle(event);
  }
}

/**
 * Validate a drained turn and produce its result, mapping a reported harness
 * failure or a missing completion event to the right typed error. `label` names the
 * CLI in the "produced no result" message (e.g. "claude", "codex").
 */
export function resolveTurnResult(
  reader: TurnReaderState,
  proc: TurnProcess,
  label: string,
): SessionTurnResult {
  const failure = reader.error();
  if (failure !== undefined) {
    throw failure.retryable
      ? new FoomHarnessUnavailableError(failure.message)
      : new FoomHarnessRejectedError(failure.message);
  }
  if (!reader.resultSeen()) {
    const detail = proc.stderr().trim();
    throw new FoomHarnessUnavailableError(
      detail.length > 0 ? detail : `${label} produced no result`,
    );
  }
  return { assistantText: reader.assistantText(), usage: reader.usage() };
}
