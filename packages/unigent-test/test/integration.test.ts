import { agent } from "@unigent/core";
import { describe, expect, it } from "vitest";
import { createScriptedBackend, createTestBackend, testResult } from "../src/index.ts";

describe("@unigent/test", () => {
  it("provides an inspectable programmable backend", async () => {
    const backend = createTestBackend((request, context) =>
      testResult(`${context.model}:${context.turnIndex}:${request.prompt}`),
    );

    const result = await agent({ name: "test", backend, model: "model" }).run("hello");

    expect(result.output).toBe("model:0:hello");
    expect(backend.requests).toHaveLength(1);
    expect(backend.openedModels).toEqual(["model"]);
  });

  it("executes declarative tool calls through the real Unigent runtime", async () => {
    const backend = createScriptedBackend([
      { toolCalls: [{ name: "unigent_return", input: { value: 7 } }] },
    ]);

    const result = await agent({ name: "test", backend, model: "model" }).run("number", {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "number" ? { value } : { issues: [{ message: "expected number" }] },
      },
    });

    expect(result.output).toBe(7);
    expect(result.trace.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool_call" })]),
    );
  });
});
