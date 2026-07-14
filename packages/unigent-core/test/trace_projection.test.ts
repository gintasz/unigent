import type { AgentEvent } from "@unigent/core";
import { TraceProjection } from "@unigent/core/trace";
import { describe, expect, it } from "vitest";

const RUN_COUNT = 5000;
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function eventsForRun(index: number): readonly AgentEvent[] {
  const traceId = `trace-${index}`;
  const spanId = `span-${index}`;
  const envelope = { traceId, spanId, timestamp: TIMESTAMP };
  return [
    { ...envelope, sequence: 0, type: "span_start", name: "worker", kind: "run" },
    { ...envelope, sequence: 1, type: "system_prompt", text: "system" },
    { ...envelope, sequence: 2, type: "user_prompt", text: `job ${index}` },
    {
      ...envelope,
      sequence: 3,
      type: "span_end",
      durationMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, calls: 1 },
      outcome: "succeeded",
    },
  ];
}

describe("incremental trace projection", () => {
  it("indexes 5000 complete runs without retaining a duplicate event array", () => {
    const projection = new TraceProjection();
    for (let index = 0; index < RUN_COUNT; index += 1) {
      for (const event of eventsForRun(index)) {
        projection.append(event);
      }
    }

    const snapshot = projection.snapshot();
    expect(snapshot.eventCount).toBe(20_000);
    expect(snapshot.tree.roots).toHaveLength(RUN_COUNT);
    expect(snapshot.tree.usage.totalTokens).toBe(10_000);
    expect(snapshot.transcript).toHaveLength(10_000);
  });

  it("coalesces interleaved streaming chunks independently per span", () => {
    const projection = new TraceProjection();
    const [first] = eventsForRun(1);
    const [second] = eventsForRun(2);
    if (first === undefined || second === undefined) {
      throw new Error("trace fixtures are incomplete");
    }
    projection.append(first);
    projection.append(second);
    projection.append({
      traceId: "trace-1",
      spanId: "span-1",
      sequence: 1,
      timestamp: TIMESTAMP,
      type: "text",
      text: "one-",
    });
    projection.append({
      traceId: "trace-2",
      spanId: "span-2",
      sequence: 1,
      timestamp: TIMESTAMP,
      type: "text",
      text: "two-",
    });
    projection.append({
      traceId: "trace-1",
      spanId: "span-1",
      sequence: 2,
      timestamp: TIMESTAMP,
      type: "text",
      text: "complete",
    });
    projection.append({
      traceId: "trace-2",
      spanId: "span-2",
      sequence: 2,
      timestamp: TIMESTAMP,
      type: "text",
      text: "complete",
    });

    expect(projection.snapshot().transcript).toEqual([
      { kind: "assistant", spanId: "span-1", text: "one-complete" },
      { kind: "assistant", spanId: "span-2", text: "two-complete" },
    ]);
  });

  it("does not mutate an earlier snapshot when later events append", () => {
    const projection = new TraceProjection();
    const events = eventsForRun(1);
    const [start] = events;
    if (start === undefined) {
      throw new Error("trace fixture is incomplete");
    }
    projection.append(start);
    const before = projection.snapshot();

    for (const event of events.slice(1)) {
      projection.append(event);
    }

    expect(before.tree.roots).toHaveLength(1);
    expect(before.tree.roots[0]?.outcome).toBe("running");
    expect(before.transcript).toEqual([]);
    expect(projection.snapshot().tree.roots[0]?.outcome).toBe("succeeded");
  });
});
