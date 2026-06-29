// The response bridge: turn OpenCode's `session.prompt` result (an assistant
// message `info` + its `parts`) into the microfoom `SessionTurnResult` — final
// prose and the turn's usage — and surface the live transcript as `StreamEvent`s.
// Usage and cost come straight off the returned message (`info.tokens`/`info.cost`),
// so this adapter never depends on the CLI's flaky `step_finish` stdout event.
// A model-side failure (`info.error`) maps to a retryable turn error.

import type { StreamEvent, UsageDelta } from "@microfoom/core";
import { stripPrefix } from "./rename.js";

/** A raw decoded value from the SDK response. Shapes are validated structurally. */
type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null ? (value as Json) : undefined;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const EMPTY_USAGE: UsageDelta = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Why a turn ended badly (mapped to a FoomHarnessError by the caller). */
interface TurnError {
  readonly message: string;
  /** Whether retrying could plausibly succeed (transient model/network/rate-limit). */
  readonly retryable: boolean;
}

/** What the reader distils from one prompt's response. */
interface TurnOutcome {
  readonly assistantText: string;
  readonly usage: UsageDelta;
  readonly error?: TurnError;
}

/** Map an OpenCode assistant-message `tokens` block (+ cost) to a UsageDelta. */
function usageFromInfo(info: Json): UsageDelta {
  const tokens = asObject(info["tokens"]);
  if (tokens === undefined) {
    return EMPTY_USAGE;
  }
  const input = asNumber(tokens["input"]);
  const output = asNumber(tokens["output"]);
  const reasoning = asNumber(tokens["reasoning"]);
  const cache = asObject(tokens["cache"]) ?? {};
  const cacheRead = asNumber(cache["read"]);
  const cacheWrite = asNumber(cache["write"]);
  // Prefer OpenCode's own `total` when present; else sum every component so a
  // budget/usage gate never sees a zero total for a turn that really spent tokens.
  const total = asNumber(tokens["total"]) || input + output + reasoning + cacheRead + cacheWrite;
  const cost = asNumber(info["cost"]);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
    ...(cost > 0 ? { costUsd: cost } : {}),
  };
}

/** A model-side error block on the assistant message, if any. */
function errorFromInfo(info: Json): TurnError | undefined {
  const error = asObject(info["error"]);
  if (error === undefined) {
    return;
  }
  const data = asObject(error["data"]) ?? {};
  const message = asString(data["message"]) ?? asString(error["name"]) ?? "opencode model error";
  // Every surfaced model/provider failure is treated as retryable (transient):
  // the run's own caps decide whether to retry, and a dead provider then skips.
  return { message, retryable: true };
}

// Emit one message part as StreamEvents and return any prose text it carried.
function emitPart(part: Json, serverName: string, emit: (event: StreamEvent) => void): string {
  switch (part["type"]) {
    case "text": {
      const delta = asString(part["text"]) ?? "";
      if (delta.length > 0) {
        emit({ type: "text", delta });
      }
      return delta;
    }
    case "reasoning": {
      const delta = asString(part["text"]) ?? "";
      if (delta.length > 0) {
        emit({ type: "reasoning", delta });
      }
      return "";
    }
    case "tool": {
      const state = asObject(part["state"]) ?? {};
      const callId = asString(part["callID"]) ?? "";
      emit({
        type: "tool_call",
        callId,
        name: stripPrefix(serverName, asString(part["tool"]) ?? ""),
        args: state["input"],
      });
      if (state["status"] === "completed" || state["status"] === "error") {
        emit({
          type: "tool_result",
          callId,
          content: asString(state["output"]) ?? "",
          isError: state["status"] === "error",
        });
      }
      return "";
    }
    default:
      return "";
  }
}

/**
 * Emit the transcript of one assistant message (its parts, in order) as
 * StreamEvents, wrapped in message_start/message_end. Used to surface OpenCode's
 * full per-turn transcript — including the tool calls, which the `session.prompt`
 * return value omits — by replaying the session's recorded messages.
 */
function emitMessageParts(
  parts: readonly unknown[],
  serverName: string,
  onEvent: (event: StreamEvent) => void,
): void {
  onEvent({ type: "message_start" });
  for (const raw of parts) {
    const part = asObject(raw);
    if (part !== undefined) {
      emitPart(part, serverName, onEvent);
    }
  }
  onEvent({ type: "message_end" });
}

/**
 * Interpret one `session.prompt` response. `onEvent` (when supplied) receives the
 * live transcript distilled from the returned message's parts.
 */
function readPromptResponse(
  response: unknown,
  serverName: string,
  onEvent: ((event: StreamEvent) => void) | undefined,
): TurnOutcome {
  const data = asObject(asObject(response)?.["data"]) ?? asObject(response) ?? {};
  const info = asObject(data["info"]) ?? {};
  const parts = asArray(data["parts"]);

  const emit = (event: StreamEvent): void => {
    if (onEvent !== undefined) {
      onEvent(event);
    }
  };

  emit({ type: "message_start" });
  let text = "";
  for (const raw of parts) {
    const part = asObject(raw);
    if (part !== undefined) {
      text += emitPart(part, serverName, emit);
    }
  }
  emit({ type: "message_end" });

  const error = errorFromInfo(info);
  return {
    assistantText: text,
    usage: usageFromInfo(info),
    ...(error === undefined ? {} : { error }),
  };
}

export type { TurnOutcome };
export { emitMessageParts, readPromptResponse, usageFromInfo };
