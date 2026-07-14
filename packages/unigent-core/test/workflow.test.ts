import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCancelledError,
  AgentTimeoutError,
  agent,
  createFileCheckpointStore,
  createMemoryCheckpointStore,
  done,
  tool,
} from "@unigent/core";
import { createTestBackend, testResult } from "@unigent/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("workflow scopes", () => {
  it("names traces, aggregates nested scopes, and retains scope observations", async () => {
    const backend = createTestBackend(() => testResult("ok"));
    const workflow = agent({ name: "worker", backend, model: "test" }).scope("workflow");
    const ranking = workflow.scope("ranking");
    workflow.log("workflow starting");
    ranking.annotate({ candidates: 3 });

    const result = await ranking.run("rank");

    expect(result.output).toBe("ok");
    expect(ranking.path).toEqual(["workflow", "ranking"]);
    expect(ranking.usage.totalTokens).toBe(2);
    expect(workflow.usage.totalTokens).toBe(2);
    expect(ranking.traces).toHaveLength(1);
    expect(workflow.traces).toHaveLength(1);
    const root = result.trace.events.find((event) => event.type === "span_start");
    expect(root).toMatchObject({
      name: "ranking",
      agent: "worker",
      scopePath: ["workflow", "ranking"],
    });
    expect(result.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "log", message: "workflow starting" }),
        expect.objectContaining({ type: "annotate", attributes: { candidates: 3 } }),
      ]),
    );
  });

  it("aborts every concurrent run owned by one scope", async () => {
    const backend = createTestBackend(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const workflow = agent({ name: "worker", backend, model: "test" }).scope("workflow");
    const first = workflow.run("one");
    const second = workflow.run("two");
    workflow.abort("stop all");

    const settled = await Promise.allSettled([first, second]);

    expect(settled).toHaveLength(2);
    expect(
      settled.every(
        (result) => result.status === "rejected" && result.reason instanceof AgentCancelledError,
      ),
    ).toBe(true);
  });

  it("enforces one deadline across the entire scope lifetime", async () => {
    const backend = createTestBackend(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const workflow = agent({ name: "worker", backend, model: "test" }).scope("workflow", {
      duration: "0.01s",
    });

    await expect(workflow.run("wait")).rejects.toBeInstanceOf(AgentTimeoutError);
  });
});

describe("stateless checkpoints", () => {
  it("recalls completed runs and preserves usage without reopening the backend", async () => {
    let calls = 0;
    const backend = createTestBackend(() => {
      calls += 1;
      return testResult(`answer-${calls}`);
    });
    const store = createMemoryCheckpointStore();
    const workflow = agent({
      name: "worker",
      backend,
      model: "test",
      checkpoint: store,
    }).scope("workflow");

    const first = await workflow.run("same");
    const second = await workflow.run("same");

    expect(first.output).toBe("answer-1");
    expect(second.output).toBe("answer-1");
    expect(calls).toBe(1);
    expect(workflow.usage).toMatchObject({ totalTokens: 4, calls: 2 });
    expect(second.trace.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "checkpoint", action: "hit" })]),
    );
  });

  it("deduplicates concurrent identical runs and supports explicit identity salts", async () => {
    let calls = 0;
    const backend = createTestBackend(async () => {
      calls += 1;
      await Promise.resolve();
      return testResult(`answer-${calls}`);
    });
    const store = createMemoryCheckpointStore();
    const assistant = agent({ name: "worker", backend, model: "test", checkpoint: store });

    const [first, second] = await Promise.all([assistant.run("same"), assistant.run("same")]);
    const distinct = await assistant.with({ checkpointKey: "sample-2" }).run("same");

    expect([first.output, second.output]).toEqual(["answer-1", "answer-1"]);
    expect(distinct.output).toBe("answer-2");
    expect(calls).toBe(2);
  });

  it("invalidates checkpoints when a tool implementation changes", async () => {
    let calls = 0;
    const backend = createTestBackend(() => {
      calls += 1;
      return testResult(`answer-${calls}`);
    });
    const store = createMemoryCheckpointStore();
    const firstTool = tool({
      name: "adjust",
      description: "Adjust a value.",
      input: z.object({ value: z.number() }),
      execute: ({ value }) => value + 1,
    });
    const secondTool = tool({
      name: "adjust",
      description: "Adjust a value.",
      input: z.object({ value: z.number() }),
      execute: ({ value }) => value + 2,
    });

    const first = agent({
      name: "worker",
      backend,
      model: "test",
      tools: [firstTool],
      checkpoint: store,
    });
    const second = agent({
      name: "worker",
      backend,
      model: "test",
      tools: [secondTool],
      checkpoint: store,
    });

    expect((await first.run("same")).output).toBe("answer-1");
    expect((await second.run("same")).output).toBe("answer-2");
    expect(calls).toBe(2);
  });

  it("never checkpoints stateful session turns", async () => {
    let calls = 0;
    const backend = createTestBackend(() => {
      calls += 1;
      return testResult(String(calls));
    });
    const session = agent({
      name: "worker",
      backend,
      model: "test",
      checkpoint: createMemoryCheckpointStore(),
    }).session();

    expect((await session.run("same")).output).toBe("1");
    expect((await session.run("same")).output).toBe("2");
    expect(calls).toBe(2);
  });

  it("persists JSONL, serializes concurrent writes, and ignores a truncated tail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unigent-checkpoints-"));
    const file = join(directory, "runs.jsonl");
    let calls = 0;
    const backend = createTestBackend(() => {
      calls += 1;
      return testResult(`answer-${calls}`);
    });
    const firstStore = createFileCheckpointStore(file);
    const assistant = agent({ name: "worker", backend, model: "test", checkpoint: firstStore });

    await Promise.all([assistant.run("one"), assistant.run("two")]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    appendFileSync(file, "{truncated");

    const resumed = agent({
      name: "worker",
      backend,
      model: "test",
      checkpoint: createFileCheckpointStore(file),
    });
    expect((await resumed.run("one")).output).toBe("answer-1");
    expect((await resumed.run("two")).output).toBe("answer-2");
    expect(calls).toBe(2);
  });

  it("checkpoints structured and side-effect-only completion modes", async () => {
    let calls = 0;
    const backend = createTestBackend(async (request) => {
      calls += 1;
      const returnTool = request.tools.find((candidate) => candidate.name === "unigent_return");
      const value = request.prompt === "structured" ? { answer: 42 } : {};
      await returnTool?.execute(value === undefined ? {} : { value });
      return testResult("this prose is ignored");
    });
    const assistant = agent({
      name: "worker",
      backend,
      model: "test",
      checkpoint: createMemoryCheckpointStore(),
    });

    const structured = await assistant.run("structured", z.object({ answer: z.number() }));
    const completed = await assistant.run("side effects", done);
    const recalled = await assistant.run("side effects", done);

    expect(structured.output).toEqual({ answer: 42 });
    expect(completed.output).toBeUndefined();
    expect(recalled.output).toBeUndefined();
    expect(calls).toBe(2);
  });
});
