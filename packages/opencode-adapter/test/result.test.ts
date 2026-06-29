import type { StreamEvent } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { readPromptResponse, usageFromInfo } from "../src/result.ts";

describe("usageFromInfo", () => {
  it("maps tokens + cost, preferring the reported total", () => {
    expect(
      usageFromInfo({
        cost: 0.0019,
        tokens: { input: 100, output: 20, reasoning: 8, cache: { read: 50, write: 0 }, total: 178 },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 178,
      reasoningTokens: 8,
      cachedInputTokens: 50,
      costUsd: 0.0019,
    });
  });

  it("sums components when no total is reported", () => {
    expect(
      usageFromInfo({
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 5, write: 7 } },
      }),
    ).toMatchObject({ inputTokens: 10, outputTokens: 20, totalTokens: 42, cachedInputTokens: 5 });
  });

  it("returns a zero usage when tokens are absent", () => {
    expect(usageFromInfo({})).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

describe("readPromptResponse", () => {
  it("collects prose text and usage from the assistant message", () => {
    const out = readPromptResponse(
      {
        data: {
          info: {
            cost: 0,
            tokens: { input: 3, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 8 },
          },
          parts: [
            { type: "step-start" },
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
            { type: "step-finish" },
          ],
        },
      },
      "foom",
      undefined,
    );
    expect(out.assistantText).toBe("hello world");
    expect(out.usage.totalTokens).toBe(8);
    expect(out.error).toBeUndefined();
  });

  it("emits StreamEvents for text and tool parts (prefix stripped)", () => {
    const events: StreamEvent[] = [];
    readPromptResponse(
      {
        data: {
          info: {
            tokens: { input: 1, output: 1, total: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            { type: "text", text: "ok" },
            {
              type: "tool",
              callID: "c1",
              tool: "foom_foom_return",
              state: { status: "completed", input: { value: 7 }, output: "Returned." },
            },
          ],
        },
      },
      "foom",
      (e) => events.push(e),
    );
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

  it("surfaces a model error as a retryable turn error", () => {
    const out = readPromptResponse(
      {
        data: {
          info: { error: { name: "ProviderAuthError", data: { message: "bad key" } } },
          parts: [],
        },
      },
      "foom",
      undefined,
    );
    expect(out.error).toEqual({ message: "bad key", retryable: true });
  });
});
