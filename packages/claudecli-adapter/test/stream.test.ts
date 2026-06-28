import type { StreamEvent } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { createTurnReader, usageFromResult } from "../src/stream.ts";

const lines = (reader: ReturnType<typeof createTurnReader>, objs: Record<string, unknown>[]) => {
  for (const obj of objs) reader.handle(obj);
};

describe("stream-json turn reader", () => {
  it("collects assistant prose and the final result text", () => {
    const reader = createTurnReader("foom", undefined);
    lines(reader, [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "hi" }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "hi there",
        total_cost_usd: 0.01,
        usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 2 },
        session_id: "s1",
      },
    ]);
    expect(reader.assistantText()).toBe("hi there");
    expect(reader.sessionId()).toBe("s1");
    expect(reader.resultSeen()).toBe(true);
    expect(reader.error()).toBeUndefined();
    expect(reader.usage()).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 10,
      cachedInputTokens: 2,
      costUsd: 0.01,
    });
  });

  it("emits tool_call (prefix stripped) and tool_result events", () => {
    const events: StreamEvent[] = [];
    const reader = createTurnReader("foom", (e) => events.push(e));
    lines(reader, [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "c1", name: "mcp__foom__foom_return", input: { value: 7 } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [{ type: "text", text: "Returned." }],
            },
          ],
        },
      },
      { type: "result", subtype: "success", result: "", usage: {} },
    ]);
    const call = events.find((e) => e.type === "tool_call");
    const res = events.find((e) => e.type === "tool_result");
    expect(call).toMatchObject({
      type: "tool_call",
      callId: "c1",
      name: "foom_return",
      args: { value: 7 },
    });
    expect(res).toMatchObject({
      type: "tool_result",
      callId: "c1",
      content: "Returned.",
      isError: false,
    });
  });

  it("flags an errored result as a retryable turn error", () => {
    const reader = createTurnReader("foom", undefined);
    lines(reader, [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "boom",
        usage: {},
      },
    ]);
    expect(reader.error()).toEqual({ message: "boom", retryable: true });
  });

  it("flags a rejected rate-limit event", () => {
    const reader = createTurnReader("foom", undefined);
    reader.handle({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    expect(reader.error()?.retryable).toBe(true);
  });

  it("usageFromResult sums cache tokens into the total", () => {
    expect(
      usageFromResult(
        {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 7,
        },
        0.5,
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 42,
      cachedInputTokens: 5,
      costUsd: 0.5,
    });
  });
});
