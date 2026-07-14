import type { StandardSchemaV1 } from "@standard-schema/spec";
import { AgentRepairExhaustedError, agent, type Backend, tool } from "@unigent/core";
import { createTestBackend, testResult } from "@unigent/test";
import { describe, expect, it } from "vitest";

interface StandardNumberSchema extends StandardSchemaV1<unknown, number> {
  readonly "~standard": StandardSchemaV1.Props<unknown, number> & {
    readonly jsonSchema: {
      readonly input: (options: { readonly target: string }) => Record<string, unknown>;
    };
  };
}

const standardNumber: StandardNumberSchema = {
  "~standard": {
    version: 1,
    vendor: "unigent-test",
    validate: (value: unknown) =>
      typeof value === "number" ? { value } : { issues: [{ message: "expected number" }] },
    jsonSchema: {
      input: () => ({ $schema: "draft-2020-12", type: "number", minimum: 1 }),
    },
  },
};

/** Accept only one of two literal modes. */
function chooseMode(mode: "fast" | "safe"): string {
  return mode;
}

describe("Unigent correctness contracts", () => {
  it("uses the Standard JSON Schema input extension before compatibility projectors", async () => {
    let parameters: unknown;
    const backend = createTestBackend(async (request) => {
      const returnTool = request.tools.find((candidate) => candidate.name === "unigent_return");
      parameters = returnTool?.parameters;
      await returnTool?.execute({ value: 4 });
      return testResult("");
    });

    const result = await agent({ name: "schema", backend, model: "test" }).run(
      "number",
      standardNumber,
    );

    expect(result.output).toBe(4);
    expect(parameters).toEqual({
      type: "object",
      properties: { value: { type: "number", minimum: 1 } },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("preserves source literal unions, rejects extras, and anchors lookup to the module", async () => {
    const results: Array<{ readonly content: string; readonly isError: boolean }> = [];
    let schema: unknown;
    const backend = createTestBackend(async (request) => {
      const choose = request.tools.find((candidate) => candidate.name === "chooseMode");
      schema = choose?.parameters;
      const invalidLiteral = await choose?.execute({ mode: "reckless" });
      const extra = await choose?.execute({ mode: "fast", extra: true });
      if (invalidLiteral !== undefined) {
        results.push(invalidLiteral);
      }
      if (extra !== undefined) {
        results.push(extra);
      }
      return testResult("checked");
    });
    const assistant = agent({
      name: "source",
      source: import.meta.url,
      backend,
      model: "test",
      tools: [chooseMode],
    });

    expect((await assistant.run("validate")).output).toBe("checked");
    expect(schema).toMatchObject({
      properties: {
        mode: {
          anyOf: [
            { type: "string", const: "fast" },
            { type: "string", const: "safe" },
          ],
        },
      },
      additionalProperties: false,
    });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.isError)).toBe(true);
  });

  it("resets the repair streak after every successful user tool call", async () => {
    const identity = tool({
      name: "identity",
      description: "Return one integer.",
      input: standardNumber,
      execute: (value) => value,
    });
    const backend = createTestBackend(async (request) => {
      const identityTool = request.tools.find((candidate) => candidate.name === "identity");
      for (let index = 0; index < 4; index += 1) {
        await identityTool?.execute("invalid");
        await identityTool?.execute(index + 1);
      }
      return testResult("recovered");
    });
    const result = await agent({
      name: "repairs",
      backend,
      model: "test",
      tools: [identity],
      repairAttempts: 3,
    }).run("repair");

    expect(result.output).toBe("recovered");
    expect(
      result.trace.events.filter((event) => event.type === "repair").map((event) => event.attempt),
    ).toEqual([1, 1, 1, 1]);
  });

  it("still exhausts consecutive repair failures", async () => {
    const identity = tool({
      name: "identity",
      description: "Return one integer.",
      input: standardNumber,
      execute: (value) => value,
    });
    const backend = createTestBackend(async (request) => {
      const identityTool = request.tools.find((candidate) => candidate.name === "identity");
      for (let index = 0; index < 4; index += 1) {
        await identityTool?.execute("invalid");
      }
      return testResult("");
    });

    await expect(
      agent({ name: "exhaust", backend, model: "test", tools: [identity] }).run("fail"),
    ).rejects.toBeInstanceOf(AgentRepairExhaustedError);
  });

  it("keeps aggregate cost unknown when any backend does not report it", async () => {
    const priced = createTestBackend(() =>
      testResult("priced", { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.25 }),
    );
    const unpriced: Backend = {
      ...createTestBackend(() =>
        testResult("unpriced", { inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      ),
      capabilities: {
        reportsCost: false,
        supportsSessionFork: true,
      },
    };
    const work = agent({ name: "usage", backend: unpriced, model: "test" }).scope("work");

    await work.run("unpriced");
    await work.with({ backend: priced }).run("priced");

    expect(work.usage.calls).toBe(2);
    expect(work.usage.costUsd).toBeUndefined();
  });
});
