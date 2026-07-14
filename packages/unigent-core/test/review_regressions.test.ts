import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentConfigError,
  type AgentRun,
  AgentTimeoutError,
  agent,
  type Backend,
  type BackendTurnResult,
  type CheckpointStore,
} from "../src/index.ts";

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  calls: 1,
  costUsd: 0.1,
};

function result(text: string): BackendTurnResult {
  return { text, usage: USAGE };
}

function simpleBackend(
  handler: (prompt: string) => Promise<void> | void = () => undefined,
): Backend {
  return {
    name: "review-regression",
    capabilities: { reportsCost: true, supportsSessionFork: false },
    openSession: () => ({
      runTurn: async (request) => {
        await handler(request.prompt);
        return result(request.prompt);
      },
    }),
  };
}

describe("pre-publish runtime regressions", () => {
  it("retains only the configured number of explicit-scope traces", async () => {
    const scoped = agent({ name: "trace", backend: simpleBackend(), model: "test" }).scope(
      "workflow",
      { retainTraces: 2 },
    );

    await scoped.run("first");
    await scoped.run("second");
    await scoped.run("third");

    expect(scoped.traces).toHaveLength(2);
    expect(
      scoped.traces.map(
        (trace) => trace.events.find((event) => event.type === "user_prompt")?.text,
      ),
    ).toEqual(["second", "third"]);
    expect(() =>
      agent({ name: "trace", backend: simpleBackend(), model: "test" }).scope("bad", {
        retainTraces: -1,
      }),
    ).toThrow(AgentConfigError);
  });

  it("does not double-count nested usage when the child uses an ancestor scope", async () => {
    const base = agent({ name: "usage", backend: simpleBackend(), model: "test" });
    const workflow = base.scope("workflow");
    const parentBackend = simpleBackend(async (prompt) => {
      if (prompt === "parent") {
        await workflow.run("child");
      }
    });
    const phase = workflow.with({ backend: parentBackend }).scope("phase");

    await phase.run("parent");

    expect(phase.usage).toMatchObject({ calls: 2, costUsd: 0.2 });
    expect(workflow.usage).toMatchObject({ calls: 2, costUsd: 0.2 });
  });

  it("degrades checkpoint read and write failures without discarding output", async () => {
    const failingStore: CheckpointStore = {
      get: () => {
        throw new Error("read unavailable");
      },
      set: () => {
        throw new Error("write unavailable");
      },
    };
    const assistant = agent({
      name: "checkpoint",
      backend: simpleBackend(),
      model: "test",
      checkpoint: failingStore,
    });

    const completed = await assistant.run("still succeeds");

    expect(completed.output).toBe("still succeeds");
    expect(completed.trace.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "checkpoint", action: "miss" })]),
    );
    expect(completed.trace.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "checkpoint", action: "write" })]),
    );
  });

  it("retries opening a stateful session after a transient failure", async () => {
    let opens = 0;
    const backend: Backend = {
      ...simpleBackend(),
      openSession: async () => {
        opens += 1;
        if (opens === 1) {
          throw new Error("temporary authentication failure");
        }
        return {
          runTurn: async () => result("recovered"),
        };
      },
    };
    const session = agent({ name: "session", backend, model: "test" }).session();

    await expect(session.run("first")).rejects.toThrow("temporary authentication failure");
    await expect(session.run("second")).resolves.toMatchObject({ output: "recovered" });
    expect(opens).toBe(2);
  });

  it("returns a rejected AgentRun for invalid runtime completion input", async () => {
    const assistant = agent({ name: "boundary", backend: simpleBackend(), model: "test" });
    const runtimeAgent = assistant as unknown as {
      run: (prompt: string, completion: unknown) => AgentRun<unknown>;
    };

    const run = runtimeAgent.run("invalid", 42);

    expect(typeof run.then).toBe("function");
    await expect(run).rejects.toBeInstanceOf(AgentConfigError);
  });

  it("rejects negative retry and repair limits during agent setup", () => {
    const backend = simpleBackend();

    expect(() => agent({ name: "retry", backend, model: "test", retries: -1 })).toThrow(
      AgentConfigError,
    );
    expect(() => agent({ name: "repair", backend, model: "test", repairAttempts: -1 })).toThrow(
      AgentConfigError,
    );
  });

  it("applies turnDuration independently to each repair turn", async () => {
    let turns = 0;
    const backend: Backend = {
      ...simpleBackend(),
      openSession: () => ({
        runTurn: async (request) => {
          turns += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 60));
          if (turns === 2) {
            const returnTool = request.tools.find((tool) => tool.name === "unigent_return");
            await returnTool?.execute({ value: "done" });
          }
          return result("");
        },
      }),
    };
    const assistant = agent({
      name: "deadline",
      backend,
      model: "test",
      limits: { turnDuration: "0.1s" },
    });

    await expect(assistant.run("repair", z.string())).resolves.toMatchObject({ output: "done" });
    expect(turns).toBe(2);
  });

  it("times out one backend turn with the timeout taxonomy", async () => {
    const backend: Backend = {
      ...simpleBackend(),
      openSession: () => ({
        runTurn: (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      }),
    };
    const assistant = agent({
      name: "deadline",
      backend,
      model: "test",
      limits: { turnDuration: "0.01s" },
    });

    await expect(assistant.run("wait")).rejects.toBeInstanceOf(AgentTimeoutError);
  });

  it("streams only one nested run and terminates before its parent ends", async () => {
    const nestedEventTypes: string[] = [];
    const child = agent({ name: "child", backend: simpleBackend(), model: "child" });
    const parentBackend = simpleBackend(async () => {
      const nested = child.run("nested prompt");
      const collect = async (): Promise<void> => {
        for await (const event of nested.events) {
          if (event.type === "user_prompt") {
            nestedEventTypes.push(event.text);
          }
        }
      };
      await Promise.all([nested, collect()]);
    });
    const parent = agent({ name: "parent", backend: parentBackend, model: "parent" });

    await parent.run("parent prompt");

    expect(nestedEventTypes).toEqual(["nested prompt"]);
  });
});
