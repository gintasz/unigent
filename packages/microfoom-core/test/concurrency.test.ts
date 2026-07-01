import { describe, expect, it } from "vitest";
import {
  CONTROL_TOOLS,
  FoomCancelledError,
  FoomConcurrencyError,
  FoomConfigError,
  foom,
  type HarnessSession,
  makeStandardSchema,
  type OpenSession,
  Program,
  runProgram,
  type SessionTurnRequest,
  type SessionTurnResult,
  type UsageDelta,
} from "../src/index.ts";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);
const numberSchema = makeStandardSchema<number>((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);

const USAGE: UsageDelta = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function meteredHarness(ms: number): {
  readonly openSession: OpenSession;
  readonly maxActive: () => number;
} {
  let active = 0;
  let maxActive = 0;
  return {
    openSession: (): HarnessSession => ({
      async runTurn(_request: SessionTurnRequest): Promise<SessionTurnResult> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(ms);
        active -= 1;
        return { assistantText: "ok", usage: USAGE };
      },
    }),
    maxActive: () => maxActive,
  };
}

describe("maxConcurrentRootTurns", () => {
  it("limits concurrent stateless model turns in one run", async () => {
    const harness = meteredHarness(20);

    class P extends Program<typeof stringSchema, string[]>(stringSchema) {
      async main(): Promise<string[]> {
        return await Promise.all([
          this.agent.prose`one`,
          this.agent.prose`two`,
          this.agent.prose`three`,
          this.agent.prose`four`,
          this.agent.prose`five`,
        ]);
      }
    }

    const out = await runProgram(P, "x", {
      harnesses: { default: harness.openSession },
      model: "fake",
      defaults: { maxConcurrentRootTurns: 2 },
    });

    expect(out).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(harness.maxActive()).toBeLessThanOrEqual(2);
  });

  it("exempts nested foom_call turns from the cap, so maxConcurrentRootTurns=1 allows nested turns", async () => {
    const openSession: OpenSession = (): HarnessSession => ({
      async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
        if (request.prompt.includes("outer")) {
          const call = request.tools.find((tool) => tool.name === CONTROL_TOOLS.call);
          await call?.execute({ method: "nested", arguments: {} });
          const ret = request.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
          await ret?.execute({ value: 7 });
          return { assistantText: "", usage: USAGE };
        }
        const ret = request.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
        await ret?.execute({ value: 7 });
        return { assistantText: "", usage: USAGE };
      },
    });

    class P extends Program<typeof stringSchema, number>(stringSchema) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`outer`;
      }

      @foom.expose()
      async nested(): Promise<number> {
        return await this.agent.value(numberSchema)`inner`;
      }
    }

    await expect(
      runProgram(P, "x", {
        harnesses: { default: openSession },
        model: "fake",
        defaults: { maxConcurrentRootTurns: 1 },
      }),
    ).resolves.toBe(7);
  });

  it("returns every result when one turn issues parallel foom_calls under maxConcurrentRootTurns=1", async () => {
    // Regression: parallel foom_calls in a single assistant message must each
    // settle. The old release-during-tool lease made N concurrent tool executes
    // each re-queue for the run's single permit; the surplus blocked forever, so
    // their tool-results never came back and the turn hung. Now foom_call handlers
    // don't touch the gate at all, so this completes and all N run.
    const N = 4;
    let calls = 0;
    const openSession: OpenSession = (): HarnessSession => ({
      async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
        const call = request.tools.find((tool) => tool.name === CONTROL_TOOLS.call);
        if (call === undefined) {
          throw new Error("call tool missing");
        }
        // Fire N foom_calls concurrently — the parallel-tool case that hung before.
        await Promise.all(
          Array.from({ length: N }, () => call.execute({ method: "rate", arguments: {} })),
        );
        const ret = request.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
        await ret?.execute({ value: calls });
        return { assistantText: "", usage: USAGE };
      },
    });

    class P extends Program<typeof stringSchema, number>(stringSchema) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`outer`;
      }

      @foom.expose()
      async rate(): Promise<number> {
        calls += 1;
        return calls;
      }
    }

    // Resolves (no hang) and every foom_call ran (count === N).
    await expect(
      runProgram(P, "x", {
        harnesses: { default: openSession },
        model: "fake",
        defaults: { maxConcurrentRootTurns: 1 },
      }),
    ).resolves.toBe(N);
  });

  it("gives each method its own @foom.config under concurrent foom_calls (no methodConfig race)", async () => {
    // Regression: two foom_calls to differently-configured methods, dispatched in
    // parallel from one assistant message. Each method's nested turn must run with
    // ITS method's config. The old shared `runtime.methodConfig` field raced — one
    // invoke() overwrote the other's, so a nested turn could pick up the sibling's
    // (or no) config. The async-local call frame keeps them independent.
    const seen: Record<string, string | undefined> = {};
    const openSession: OpenSession = (): HarnessSession => ({
      async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
        if (request.prompt.includes("outer")) {
          const call = request.tools.find((tool) => tool.name === CONTROL_TOOLS.call);
          if (call === undefined) {
            throw new Error("call tool missing");
          }
          await Promise.all([
            call.execute({ method: "alpha", arguments: {} }),
            call.execute({ method: "beta", arguments: {} }),
          ]);
          const ret = request.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
          await ret?.execute({ value: "done" });
          return { assistantText: "", usage: USAGE };
        }
        // A nested turn — record the thinking level its method's config produced.
        const tag = request.prompt.includes("alpha") ? "alpha" : "beta";
        seen[tag] = request.thinking;
        const ret = request.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
        await ret?.execute({ value: tag });
        return { assistantText: "", usage: USAGE };
      },
    });

    class P extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        return await this.agent.value(stringSchema)`outer`;
      }

      @foom.config({ thinking: "high" })
      @foom.expose()
      async alpha(): Promise<string> {
        return await this.agent.value(stringSchema)`inner alpha`;
      }

      @foom.config({ thinking: "low" })
      @foom.expose()
      async beta(): Promise<string> {
        return await this.agent.value(stringSchema)`inner beta`;
      }
    }

    await runProgram(P, "x", { harnesses: { default: openSession }, model: "fake" });

    expect(seen["alpha"]).toBe("high");
    expect(seen["beta"]).toBe("low");
  });

  it("aborts a queued turn with FoomCancelledError", async () => {
    const harness = meteredHarness(40);

    class P extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        const first = this.agent.prose`first`;
        const second = this.agent.prose`second`;
        second.abort();
        await first;
        return await second;
      }
    }

    await expect(
      runProgram(P, "x", {
        harnesses: { default: harness.openSession },
        model: "fake",
        defaults: { maxConcurrentRootTurns: 1 },
      }),
    ).rejects.toBeInstanceOf(FoomCancelledError);
  });

  it("keeps same-session overlap as a programming error, not queued work", async () => {
    const harness = meteredHarness(20);

    class P extends Program<typeof stringSchema, string[]>(stringSchema) {
      async main(): Promise<string[]> {
        const session = this.agent.session();
        return await Promise.all([session.prose`one`, session.prose`two`]);
      }
    }

    await expect(
      runProgram(P, "x", {
        harnesses: { default: harness.openSession },
        model: "fake",
        defaults: { maxConcurrentRootTurns: 1 },
      }),
    ).rejects.toBeInstanceOf(FoomConcurrencyError);
  });

  it("rejects non-positive limits as config errors", async () => {
    const harness = meteredHarness(1);

    class P extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        return await this.agent.prose`go`;
      }
    }

    await expect(
      runProgram(P, "x", {
        harnesses: { default: harness.openSession },
        model: "fake",
        defaults: { maxConcurrentRootTurns: 0 },
      }),
    ).rejects.toBeInstanceOf(FoomConfigError);
  });
});
