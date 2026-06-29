// The transcript bridge: parse Claude Code's `--output-format stream-json` NDJSON
// into microfoom `StreamEvent`s, the final assistant prose, and the turn's usage.
// Tool names are stripped back to their canonical form (`mcp__foom__foom_return`
// → `foom_return`) so the run's event stream speaks core's vocabulary, not
// Claude Code's namespacing.

import {
  asArray,
  asNumber,
  asObject,
  asString,
  EMPTY_USAGE,
  type Json,
  type TurnError,
  type TurnReader,
} from "@microfoom/adapter-base";
import type { StreamEvent, UsageDelta } from "@microfoom/core";
import { stripPrefix } from "./rename.js";

/** A raw decoded stream-json line. Shapes are validated structurally as read. */
type StreamJson = Json;

/** Map a stream-json `usage` block (+ optional cost) to a microfoom UsageDelta. */
function usageFromResult(usageBlock: unknown, costUsd: number | undefined): UsageDelta {
  const usage = asObject(usageBlock) ?? {};
  const input = asNumber(usage["input_tokens"]);
  const output = asNumber(usage["output_tokens"]);
  const cacheRead = asNumber(usage["cache_read_input_tokens"]);
  const cacheCreation = asNumber(usage["cache_creation_input_tokens"]);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output + cacheRead + cacheCreation,
    cachedInputTokens: cacheRead,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/**
 * Build a reader that interprets one turn's stream. `onEvent` (when supplied)
 * receives the live transcript: assistant prose, tool calls, and tool results.
 */
/** Mutable accumulator a turn's events fold into. */
interface ReaderState {
  sessionId: string | undefined;
  resultSeen: boolean;
  error: TurnError | undefined;
  finalText: string;
  lastAssistantText: string;
  usage: UsageDelta;
}

type Emit = (event: StreamEvent) => void;

// Emit one assistant message's content blocks (text deltas + tool calls) and
// return the concatenated prose text.
function emitAssistantContent(content: unknown, emit: Emit, serverName: string): string {
  let text = "";
  for (const raw of asArray(content)) {
    const block = asObject(raw);
    if (block === undefined) {
      continue;
    }
    if (block["type"] === "text") {
      const delta = asString(block["text"]) ?? "";
      text += delta;
      emit({ type: "text", delta });
    } else if (block["type"] === "tool_use") {
      emit({
        type: "tool_call",
        callId: asString(block["id"]) ?? "",
        name: stripPrefix(serverName, asString(block["name"]) ?? ""),
        args: block["input"],
      });
    }
  }
  return text;
}

function handleAssistant(
  message: StreamJson,
  state: ReaderState,
  emit: Emit,
  serverName: string,
): void {
  emit({ type: "message_start" });
  const text = emitAssistantContent(message["content"], emit, serverName);
  emit({ type: "message_end" });
  if (text.length > 0) {
    state.lastAssistantText = text;
  }
}

function handleUser(message: StreamJson, emit: Emit): void {
  for (const raw of asArray(message["content"])) {
    const block = asObject(raw);
    if (block === undefined || block["type"] !== "tool_result") {
      continue;
    }
    const content = asArray(block["content"])
      .map((part) => asString(asObject(part)?.["text"]) ?? "")
      .join("");
    emit({
      type: "tool_result",
      callId: asString(block["tool_use_id"]) ?? "",
      content,
      isError: block["is_error"] === true,
    });
  }
}

// A non-"allowed" rate-limit status fails the turn as retryable.
function handleRateLimit(event: StreamJson, state: ReaderState): void {
  const status = asString(asObject(event["rate_limit_info"])?.["status"]);
  if (status !== undefined && status !== "allowed") {
    state.error = { message: `rate limited: ${status}`, retryable: true };
  }
}

// The terminal `result` event: capture usage/cost + final text, and surface a
// model-side failure (is_error or a non-success subtype) as a retryable error.
function handleResult(event: StreamJson, state: ReaderState): void {
  state.resultSeen = true;
  const cost = typeof event["total_cost_usd"] === "number" ? event["total_cost_usd"] : undefined;
  state.usage = usageFromResult(event["usage"], cost);
  state.finalText = asString(event["result"]) ?? "";
  if (event["is_error"] === true || (asString(event["subtype"]) ?? "success") !== "success") {
    state.error = {
      message:
        state.finalText.length > 0
          ? state.finalText
          : (asString(event["subtype"]) ?? "model error"),
      retryable: true,
    };
  }
}

function createTurnReader(
  serverName: string,
  onEvent: ((event: StreamEvent) => void) | undefined,
): TurnReader {
  const state: ReaderState = {
    sessionId: undefined,
    resultSeen: false,
    error: undefined,
    finalText: "",
    lastAssistantText: "",
    usage: EMPTY_USAGE,
  };

  const emit: Emit = (event: StreamEvent): void => {
    if (onEvent !== undefined) {
      onEvent(event);
    }
  };

  const handle = (event: StreamJson): void => {
    const sid = asString(event["session_id"]);
    if (sid !== undefined) {
      state.sessionId = sid;
    }

    switch (event["type"]) {
      case "assistant": {
        const message = asObject(event["message"]);
        if (message !== undefined) {
          handleAssistant(message, state, emit, serverName);
        }
        break;
      }
      case "user": {
        const message = asObject(event["message"]);
        if (message !== undefined) {
          handleUser(message, emit);
        }
        break;
      }
      case "rate_limit_event":
        handleRateLimit(event, state);
        break;
      case "result":
        handleResult(event, state);
        break;
      default:
        break;
    }
  };

  return {
    handle,
    sessionId: () => state.sessionId,
    resultSeen: () => state.resultSeen,
    error: () => state.error,
    assistantText: () => (state.finalText.length > 0 ? state.finalText : state.lastAssistantText),
    usage: () => state.usage,
  };
}

export { createTurnReader, usageFromResult };
