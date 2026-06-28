// The transcript bridge: parse Claude Code's `--output-format stream-json` NDJSON
// into microfoom `StreamEvent`s, the final assistant prose, and the turn's usage.
// Tool names are stripped back to their canonical form (`mcp__foom__foom_return`
// → `foom_return`) so the run's event stream speaks core's vocabulary, not
// Claude Code's namespacing.

import type { StreamEvent, UsageDelta } from "@microfoom/core";
import { stripPrefix } from "./rename.js";

/** A raw decoded stream-json line. Shapes are validated structurally as read. */
type StreamJson = Record<string, unknown>;

const asObject = (value: unknown): StreamJson | undefined =>
  typeof value === "object" && value !== null ? (value as StreamJson) : undefined;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Why a turn ended badly (mapped to a FoomtimeHarnessError by the caller). */
export interface TurnError {
  readonly message: string;
  /** Whether retrying could plausibly succeed (transient model/network/rate-limit). */
  readonly retryable: boolean;
}

/** What the reader distils from a turn's stream. */
export interface TurnReader {
  /** Feed one decoded stream-json object. */
  handle(event: StreamJson): void;
  /** The session id Claude assigned/echoed (for `--resume` continuity). */
  sessionId(): string | undefined;
  /** True once the terminal `result` event was seen. */
  resultSeen(): boolean;
  /** A turn error if the model/CLI failed, else undefined. */
  error(): TurnError | undefined;
  /** Final assistant prose for the turn. */
  assistantText(): string;
  /** Accumulated usage for the turn. */
  usage(): UsageDelta;
}

const EMPTY_USAGE: UsageDelta = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Map a stream-json `usage` block (+ optional cost) to a microfoom UsageDelta. */
export function usageFromResult(usageBlock: unknown, costUsd: number | undefined): UsageDelta {
  const usage = asObject(usageBlock) ?? {};
  const input = asNumber(usage.input_tokens);
  const output = asNumber(usage.output_tokens);
  const cacheRead = asNumber(usage.cache_read_input_tokens);
  const cacheCreation = asNumber(usage.cache_creation_input_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output + cacheRead + cacheCreation,
    cachedInputTokens: cacheRead,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Build a reader that interprets one turn's stream. `onEvent` (when supplied)
 * receives the live transcript: assistant prose, tool calls, and tool results.
 */
export function createTurnReader(
  serverName: string,
  onEvent: ((event: StreamEvent) => void) | undefined,
): TurnReader {
  let sessionId: string | undefined;
  let resultSeen = false;
  let error: TurnError | undefined;
  let finalText = "";
  let lastAssistantText = "";
  let usage: UsageDelta = EMPTY_USAGE;

  const emit = (event: StreamEvent): void => {
    if (onEvent !== undefined) onEvent(event);
  };

  // Emit one assistant message's content blocks (text deltas + tool calls) and
  // return the concatenated prose text.
  const emitAssistantContent = (content: unknown): string => {
    let text = "";
    for (const raw of asArray(content)) {
      const block = asObject(raw);
      if (block === undefined) continue;
      if (block.type === "text") {
        const delta = asString(block.text) ?? "";
        text += delta;
        emit({ type: "text", delta });
      } else if (block.type === "tool_use") {
        emit({
          type: "tool_call",
          callId: asString(block.id) ?? "",
          name: stripPrefix(serverName, asString(block.name) ?? ""),
          args: block.input,
        });
      }
    }
    return text;
  };

  const handleAssistant = (message: StreamJson): void => {
    emit({ type: "message_start" });
    const text = emitAssistantContent(message.content);
    emit({ type: "message_end" });
    if (text.length > 0) lastAssistantText = text;
  };

  const handleUser = (message: StreamJson): void => {
    for (const raw of asArray(message.content)) {
      const block = asObject(raw);
      if (block === undefined || block.type !== "tool_result") continue;
      const content = asArray(block.content)
        .map((part) => asString(asObject(part)?.text) ?? "")
        .join("");
      emit({
        type: "tool_result",
        callId: asString(block.tool_use_id) ?? "",
        content,
        isError: block.is_error === true,
      });
    }
  };

  // A non-"allowed" rate-limit status fails the turn as retryable.
  const handleRateLimit = (event: StreamJson): void => {
    const status = asString(asObject(event.rate_limit_info)?.status);
    if (status !== undefined && status !== "allowed") {
      error = { message: `rate limited: ${status}`, retryable: true };
    }
  };

  // The terminal `result` event: capture usage/cost + final text, and surface a
  // model-side failure (is_error or a non-success subtype) as a retryable error.
  const handleResult = (event: StreamJson): void => {
    resultSeen = true;
    const cost = typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined;
    usage = usageFromResult(event.usage, cost);
    finalText = asString(event.result) ?? "";
    if (event.is_error === true || (asString(event.subtype) ?? "success") !== "success") {
      error = {
        message: finalText.length > 0 ? finalText : (asString(event.subtype) ?? "model error"),
        retryable: true,
      };
    }
  };

  const handle = (event: StreamJson): void => {
    const sid = asString(event.session_id);
    if (sid !== undefined) sessionId = sid;

    switch (event.type) {
      case "assistant": {
        const message = asObject(event.message);
        if (message !== undefined) handleAssistant(message);
        break;
      }
      case "user": {
        const message = asObject(event.message);
        if (message !== undefined) handleUser(message);
        break;
      }
      case "rate_limit_event":
        handleRateLimit(event);
        break;
      case "result":
        handleResult(event);
        break;
      default:
        break;
    }
  };

  return {
    handle,
    sessionId: () => sessionId,
    resultSeen: () => resultSeen,
    error: () => error,
    assistantText: () => (finalText.length > 0 ? finalText : lastAssistantText),
    usage: () => usage,
  };
}
