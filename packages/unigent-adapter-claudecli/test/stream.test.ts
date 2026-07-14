import type { BackendEvent } from "@unigent/core";
import { describe, expect, it } from "vitest";
import { ClaudeStreamReader } from "../src/stream.ts";

function streamEvent(event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { type: "stream_event", session_id: "session", event };
}

describe("Claude stream-json normalization", () => {
  it("streams text and reasoning without duplicating completed assistant messages", () => {
    const events: BackendEvent[] = [];
    const reader = new ClaudeStreamReader((event) => events.push(event));
    reader.handle(
      streamEvent({
        type: "message_start",
        message: { id: "message-1" },
      }),
    );
    reader.handle(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "considering" },
      }),
    );
    reader.handle(
      streamEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "hello" },
      }),
    );
    reader.handle({
      type: "assistant",
      session_id: "session",
      message: { id: "message-1", content: [{ type: "text", text: "hello" }] },
    });
    reader.handle({
      type: "result",
      subtype: "success",
      session_id: "session",
      result: "hello",
      usage: { input_tokens: 2, output_tokens: 1 },
    });

    expect(events).toEqual([
      { type: "reasoning", text: "considering" },
      { type: "text", text: "hello" },
    ]);
    expect(reader.result()?.text).toBe("hello");
  });

  it("assembles streamed tool input and correlates tool results by call id", () => {
    const events: BackendEvent[] = [];
    const reader = new ClaudeStreamReader((event) => events.push(event));
    reader.handle(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-1",
          name: "mcp__unigent__finish",
          input: {},
        },
      }),
    );
    reader.handle(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"value":' },
      }),
    );
    reader.handle(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "9}" },
      }),
    );
    reader.handle(streamEvent({ type: "content_block_stop", index: 0 }));
    reader.handle({
      type: "user",
      session_id: "session",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: [{ type: "text", text: "accepted" }],
          },
        ],
      },
    });

    expect(events).toEqual([
      { type: "tool_call", callId: "call-1", name: "finish", input: { value: 9 } },
      {
        type: "tool_result",
        callId: "call-1",
        name: "finish",
        output: "accepted",
        isError: false,
      },
    ]);
  });
});
