import type { AgentEvent } from "@unigent/core";
import { describe, expect, it } from "vitest";
import { parseTraceRecord, serializeTraceEvent } from "../src/protocol.ts";

describe("trace transport", () => {
  it("round-trips a normalized event", () => {
    const event: AgentEvent = {
      type: "text",
      traceId: "trace",
      spanId: "span",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      text: "hello",
    };

    expect(parseTraceRecord(serializeTraceEvent(event).trim())).toEqual({ version: 1, event });
  });

  it("makes circular tool payloads safe without rejecting the event", () => {
    const input: { self?: unknown } = {};
    input.self = input;
    const event: AgentEvent = {
      type: "tool_call",
      traceId: "trace",
      spanId: "span",
      sequence: 2,
      timestamp: "2026-01-01T00:00:00.000Z",
      callId: "call",
      name: "circular",
      input,
    };

    expect(serializeTraceEvent(event)).toContain("[Circular]");
  });

  it("preserves repeated sibling objects that are not circular", () => {
    const shared = { value: "preserved" };
    const event: AgentEvent = {
      type: "tool_call",
      traceId: "trace",
      spanId: "span",
      sequence: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
      callId: "call",
      name: "shared",
      input: { first: shared, second: shared },
    };

    const serialized = serializeTraceEvent(event);

    expect(serialized).not.toContain("[Circular]");
    expect(serialized.match(/preserved/gu)).toHaveLength(2);
  });

  it("handles cycles inside truncated arrays", () => {
    const input: unknown[] = Array.from({ length: 101 }, (_, index) => index);
    input[0] = input;
    const event: AgentEvent = {
      type: "tool_call",
      traceId: "trace",
      spanId: "span",
      sequence: 4,
      timestamp: "2026-01-01T00:00:00.000Z",
      callId: "call",
      name: "long-circular-array",
      input,
    };

    const serialized = serializeTraceEvent(event);

    expect(serialized).toContain("[Circular]");
    expect(serialized).toContain("[truncated 1 items]");
  });
});
