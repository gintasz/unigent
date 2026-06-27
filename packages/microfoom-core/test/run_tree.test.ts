// The auto span tree (F8): runProgram's onEvent emits span_start/span_end so a
// frontend can render a run panel. buildRunTree folds that stream into a tree with
// usage rolled up from the turn leaves.

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import type { AgentUsage } from "../src/index.ts";
import { CONTROL_TOOLS, Program, runProgram } from "../src/index.ts";
import { makeStandardSchema } from "../src/standard_schema.ts";
import { type AgentEvent, buildRunTree, type RunNode } from "../src/trace/index.ts";
import { fakeOpenSession } from "./fake_session.ts";

const stringSchema: StandardSchemaV1<unknown, string> = makeStandardSchema((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "string" }] },
);

const usage = (totalTokens: number, costUsd: number): AgentUsage => ({
  inputTokens: 0,
  outputTokens: totalTokens,
  totalTokens,
  costUsd,
  calls: 1,
  maxCallDepth: 0,
});

describe("run span tree — live emission (F8)", () => {
  it("emits a program→turn tree with usage rolled up to the root", async () => {
    const events: AgentEvent[] = [];
    class Greeter extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        return await this.agent.value(stringSchema)`greet`;
      }
    }

    const out = await runProgram(Greeter, "x", {
      openSession: fakeOpenSession(
        [{ call: { name: CONTROL_TOOLS.return, args: { value: "hi" } } }],
        {
          inputTokens: 3,
          outputTokens: 7,
          totalTokens: 10,
          costUsd: 0.02,
        },
      ),
      model: "fake",
      onEvent: (event) => events.push(event),
    });
    expect(out).toBe("hi");

    const tree = buildRunTree(events);
    expect(tree.kind).toBe("program");
    expect(tree.name).toBe("main");
    expect(tree.settled).toBe(true);
    expect(tree.children).toHaveLength(1);

    const turn = tree.children[0] as RunNode;
    expect(turn.kind).toBe("turn");
    expect(turn.usage.costUsd).toBe(0.02);
    expect(turn.usage.totalTokens).toBe(10);
    // Root rolls the leaf up.
    expect(tree.usage.costUsd).toBe(0.02);
    expect(tree.usage.totalTokens).toBe(10);
    expect(typeof tree.durationMs).toBe("number");
  });

  it("emits nothing when there is no subscriber (zero-cost path still runs)", async () => {
    class Quiet extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        return await this.agent.value(stringSchema)`greet`;
      }
    }
    const out = await runProgram(Quiet, "x", {
      openSession: fakeOpenSession([
        { call: { name: CONTROL_TOOLS.return, args: { value: "ok" } } },
      ]),
      model: "fake",
    });
    expect(out).toBe("ok");
  });
});

describe("buildRunTree — projection (pure)", () => {
  it("nests by parent and rolls usage up from turn leaves", () => {
    // main → turn(t1) → method(double) → turn(t2). Only turns carry real usage.
    const events: AgentEvent[] = [
      { type: "span_start", span: "s-main", name: "main", kind: "program" },
      { type: "span_start", span: "s-t1", parent: "s-main", name: "value", kind: "turn" },
      { type: "turn_start", span: "s-t1" },
      { type: "foom_call", span: "s-t1", method: "double" },
      { type: "span_start", span: "s-m", parent: "s-t1", name: "double", kind: "method" },
      { type: "span_start", span: "s-t2", parent: "s-m", name: "value", kind: "turn" },
      { type: "span_end", span: "s-t2", durationMs: 20, usage: usage(5, 0.05) },
      { type: "span_end", span: "s-m", durationMs: 25, usage: usage(0, 0) },
      { type: "span_end", span: "s-t1", durationMs: 40, usage: usage(3, 0.03) },
      { type: "span_end", span: "s-main", durationMs: 50, usage: usage(0, 0) },
    ];

    const tree = buildRunTree(events);
    expect(tree.name).toBe("main");
    expect(tree.durationMs).toBe(50);
    // 0.03 (t1) + 0.05 (t2 under method) = 0.08 total at the root.
    expect(tree.usage.costUsd).toBeCloseTo(0.08, 6);
    expect(tree.usage.totalTokens).toBe(8);

    const t1 = tree.children[0] as RunNode;
    expect(t1.kind).toBe("turn");
    expect(t1.foomCalls).toEqual(["double"]);
    // t1 inclusive = own 0.03 + method subtree 0.05.
    expect(t1.usage.costUsd).toBeCloseTo(0.08, 6);

    const method = t1.children[0] as RunNode;
    expect(method.kind).toBe("method");
    expect(method.name).toBe("double");
    expect(method.usage.costUsd).toBeCloseTo(0.05, 6);
  });

  it("attaches annotations, logs and repairs to their span", () => {
    const events: AgentEvent[] = [
      { type: "span_start", span: "s", name: "audit", kind: "turn" },
      { type: "annotate", span: "s", attributes: { routes: 3 } },
      { type: "log", span: "s", message: "auditing", level: "warn" },
      { type: "repair", span: "s", attempt: 2 },
      { type: "span_end", span: "s", durationMs: 5, usage: usage(1, 0) },
    ];
    const tree = buildRunTree(events);
    expect(tree.annotations).toEqual({ routes: 3 });
    expect(tree.logs).toEqual([{ message: "auditing", level: "warn" }]);
    expect(tree.repairs).toBe(2);
  });

  it("wraps several top-level spans in a synthetic run root", () => {
    const events: AgentEvent[] = [
      { type: "span_start", span: "a", name: "a", kind: "turn" },
      { type: "span_end", span: "a", durationMs: 1, usage: usage(1, 0.01) },
      { type: "span_start", span: "b", name: "b", kind: "turn" },
      { type: "span_end", span: "b", durationMs: 1, usage: usage(1, 0.01) },
    ];
    const tree = buildRunTree(events);
    expect(tree.name).toBe("run");
    expect(tree.children).toHaveLength(2);
    expect(tree.usage.costUsd).toBeCloseTo(0.02, 6);
  });
});
