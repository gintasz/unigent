// The transcript bridge: parse the Codex CLI's `exec --json` JSONL into microfoom
// `StreamEvent`s, the final assistant prose, and the turn's usage. Codex emits
// whole items (not token deltas) keyed by `type`:
//
//   {"type":"thread.started","thread_id":"…"}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"type":"mcp_tool_call","tool":"foom_return",…}}
//   {"type":"item.completed","item":{"type":"mcp_tool_call",…,"status":"completed"}}
//   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
//   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
//
// Codex names MCP tools to the model under their bare canonical name (`foom_return`),
// so no name reconciliation is needed — the run's event stream already speaks core's
// vocabulary.

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

/** A raw decoded JSONL line. Shapes are validated structurally as read. */
type StreamJson = Json;

/** Map a Codex `usage` block to a microfoom UsageDelta. Codex's `input_tokens`
 *  already includes its `cached_input_tokens`, so the total is input + output. No
 *  per-turn cost is reported, so `costUsd` is left absent. */
function usageFromTurn(usageBlock: unknown): UsageDelta {
  const usage = asObject(usageBlock) ?? {};
  const input = asNumber(usage["input_tokens"]);
  const output = asNumber(usage["output_tokens"]);
  const cached = asNumber(usage["cached_input_tokens"]);
  const reasoning = asNumber(usage["reasoning_output_tokens"]);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** Mutable accumulator a turn's events fold into. */
interface ReaderState {
  sessionId: string | undefined;
  resultSeen: boolean;
  error: TurnError | undefined;
  lastAssistantText: string;
  usage: UsageDelta;
}

type Emit = (event: StreamEvent) => void;

/** Concatenate the text parts of an MCP tool result's `content` array. */
function toolResultText(result: unknown): string {
  return asArray(asObject(result)?.["content"])
    .map((part) => asString(asObject(part)?.["text"]) ?? "")
    .join("");
}

// An `item.started`: announce the live tool call (Codex carries no separate
// assistant-message boundary for MCP calls).
function handleItemStarted(item: StreamJson, emit: Emit): void {
  if (item["type"] === "mcp_tool_call" || item["type"] === "function_call") {
    emit({
      type: "tool_call",
      callId: asString(item["id"]) ?? "",
      name: asString(item["tool"]) ?? asString(item["name"]) ?? "",
      args: item["arguments"] ?? {},
    });
  }
}

// An `item.completed`: a finished assistant message, reasoning block, or tool call.
function handleItemCompleted(item: StreamJson, state: ReaderState, emit: Emit): void {
  switch (item["type"]) {
    case "agent_message": {
      const text = asString(item["text"]) ?? "";
      emit({ type: "message_start" });
      emit({ type: "text", delta: text });
      emit({ type: "message_end" });
      if (text.length > 0) {
        state.lastAssistantText = text;
      }
      break;
    }
    case "reasoning": {
      const text = asString(item["text"]) ?? "";
      if (text.length > 0) {
        emit({ type: "reasoning", delta: text });
      }
      break;
    }
    case "mcp_tool_call":
    case "function_call": {
      emit({
        type: "tool_result",
        callId: asString(item["id"]) ?? "",
        content: toolResultText(item["result"]),
        isError: item["status"] === "failed" || asObject(item["error"]) !== undefined,
      });
      break;
    }
    default:
      break;
  }
}

function createTurnReader(onEvent: ((event: StreamEvent) => void) | undefined): TurnReader {
  const state: ReaderState = {
    sessionId: undefined,
    resultSeen: false,
    error: undefined,
    lastAssistantText: "",
    usage: EMPTY_USAGE,
  };

  const emit: Emit = (event: StreamEvent): void => {
    if (onEvent !== undefined) {
      onEvent(event);
    }
  };

  const handle = (event: StreamJson): void => {
    switch (event["type"]) {
      case "thread.started": {
        const id = asString(event["thread_id"]);
        if (id !== undefined) {
          state.sessionId = id;
        }
        break;
      }
      case "item.started": {
        const item = asObject(event["item"]);
        if (item !== undefined) {
          handleItemStarted(item, emit);
        }
        break;
      }
      case "item.completed": {
        const item = asObject(event["item"]);
        if (item !== undefined) {
          handleItemCompleted(item, state, emit);
        }
        break;
      }
      case "turn.completed":
        state.resultSeen = true;
        state.usage = usageFromTurn(event["usage"]);
        break;
      case "turn.failed": {
        const message = asString(asObject(event["error"])?.["message"]) ?? "codex turn failed";
        state.error = { message, retryable: true };
        break;
      }
      case "error": {
        const message = asString(event["message"]) ?? "codex error";
        state.error = { message, retryable: true };
        break;
      }
      default:
        break;
    }
  };

  return {
    handle,
    sessionId: () => state.sessionId,
    resultSeen: () => state.resultSeen,
    error: () => state.error,
    assistantText: () => state.lastAssistantText,
    usage: () => state.usage,
  };
}

export { createTurnReader, usageFromTurn };
