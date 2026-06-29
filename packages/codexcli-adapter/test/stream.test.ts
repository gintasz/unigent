// The codex `exec --json` JSONL parser: prove session-id capture, transcript event
// emission (tool_call / tool_result / message / reasoning), usage mapping, and
// error surfacing — all from raw event objects, no subprocess.

import type { StreamEvent } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { createTurnReader, usageFromTurn } from "../src/stream.ts";

function drive(events: ReadonlyArray<Record<string, unknown>>): {
  emitted: StreamEvent[];
  reader: ReturnType<typeof createTurnReader>;
} {
  const emitted: StreamEvent[] = [];
  const reader = createTurnReader((event) => emitted.push(event));
  for (const event of events) {
    reader.handle(event);
  }
  return { emitted, reader };
}

describe("createTurnReader", () => {
  it("captures the thread id from thread.started", () => {
    const { reader } = drive([{ type: "thread.started", thread_id: "thr_123" }]);
    expect(reader.sessionId()).toBe("thr_123");
  });

  it("emits tool_call on item.started and tool_result on item.completed", () => {
    const { emitted } = drive([
      {
        type: "item.started",
        item: { id: "item_0", type: "mcp_tool_call", tool: "foom_return", arguments: { value: 9 } },
      },
      {
        type: "item.completed",
        item: {
          id: "item_0",
          type: "mcp_tool_call",
          tool: "foom_return",
          result: { content: [{ type: "text", text: "ok" }] },
          status: "completed",
        },
      },
    ]);
    expect(emitted).toContainEqual({
      type: "tool_call",
      callId: "item_0",
      name: "foom_return",
      args: { value: 9 },
    });
    expect(emitted).toContainEqual({
      type: "tool_result",
      callId: "item_0",
      content: "ok",
      isError: false,
    });
  });

  it("marks a failed tool item as an error result", () => {
    const { emitted } = drive([
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          tool: "foom_call",
          result: { content: [] },
          error: { message: "boom" },
          status: "failed",
        },
      },
    ]);
    const result = emitted.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
  });

  it("captures the final assistant message and its boundaries", () => {
    const { emitted, reader } = drive([
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "the answer" } },
    ]);
    expect(reader.assistantText()).toBe("the answer");
    expect(emitted).toContainEqual({ type: "message_start" });
    expect(emitted).toContainEqual({ type: "text", delta: "the answer" });
    expect(emitted).toContainEqual({ type: "message_end" });
  });

  it("emits reasoning deltas", () => {
    const { emitted } = drive([
      { type: "item.completed", item: { id: "r0", type: "reasoning", text: "thinking" } },
    ]);
    expect(emitted).toContainEqual({ type: "reasoning", delta: "thinking" });
  });

  it("records completion + usage from turn.completed", () => {
    const { reader } = drive([
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 10,
          reasoning_output_tokens: 5,
        },
      },
    ]);
    expect(reader.resultSeen()).toBe(true);
    expect(reader.usage()).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedInputTokens: 40,
      reasoningTokens: 5,
    });
  });

  it("surfaces turn.failed and error events as retryable errors", () => {
    const failed = drive([{ type: "turn.failed", error: { message: "rate limited" } }]);
    expect(failed.reader.error()).toEqual({ message: "rate limited", retryable: true });
    const errored = drive([{ type: "error", message: "stream broke" }]);
    expect(errored.reader.error()).toEqual({ message: "stream broke", retryable: true });
  });
});

describe("usageFromTurn", () => {
  it("omits cached/reasoning when zero and never reports cost", () => {
    expect(usageFromTurn({ input_tokens: 5, output_tokens: 2 })).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
    });
  });

  it("defaults missing usage to zeros", () => {
    expect(usageFromTurn(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});
