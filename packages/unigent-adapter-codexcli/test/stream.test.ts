import type { BackendEvent } from "@unigent/core";
import { describe, expect, it } from "vitest";
import { CodexStreamReader, usageFromTurn } from "../src/stream.ts";

describe("Codex JSONL normalization", () => {
  it("captures session, tools, reasoning, prose, and usage", () => {
    const events: BackendEvent[] = [];
    const reader = new CodexStreamReader((event) => events.push(event));

    reader.handle({ type: "thread.started", thread_id: "session-1" });
    reader.handle({
      type: "item.started",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        tool: "unigent_return",
        arguments: { value: 9 },
      },
    });
    reader.handle({ type: "item.completed", item: { type: "reasoning", text: "checking" } });
    reader.handle({
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "mcp_tool_call",
        tool: "unigent_return",
        result: { content: [{ type: "text", text: "accepted" }] },
        status: "completed",
      },
    });
    reader.handle({ type: "item.completed", item: { type: "agent_message", text: "finished" } });
    reader.handle({
      type: "turn.completed",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 4,
        reasoning_output_tokens: 2,
      },
    });

    expect(reader.sessionId()).toBe("session-1");
    expect(events).toEqual([
      { type: "tool_call", callId: "tool-1", name: "unigent_return", input: { value: 9 } },
      { type: "reasoning", text: "checking" },
      {
        type: "tool_result",
        callId: "tool-1",
        name: "unigent_return",
        output: "accepted",
        isError: false,
      },
      { type: "text", text: "finished" },
    ]);
    expect(reader.result()).toEqual({
      text: "finished",
      usage: {
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 4,
        reasoningTokens: 2,
        totalTokens: 16,
      },
    });
  });

  it("maps Codex terminal errors into a backend failure", () => {
    const reader = new CodexStreamReader(() => undefined);
    reader.handle({ type: "turn.failed", error: { message: "rate limited" } });

    expect(reader.error()).toBe("rate limited");
  });

  it("tolerates partial usage data", () => {
    expect(usageFromTurn(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });
});
