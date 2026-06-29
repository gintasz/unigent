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

describe("maxConcurrentTurns", () => {
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
      defaults: { maxConcurrentTurns: 2 },
    });

    expect(out).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(harness.maxActive()).toBeLessThanOrEqual(2);
  });

  it("releases capacity while handling foom_call, so maxConcurrentTurns=1 allows nested turns", async () => {
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
        defaults: { maxConcurrentTurns: 1 },
      }),
    ).resolves.toBe(7);
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
        defaults: { maxConcurrentTurns: 1 },
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
        defaults: { maxConcurrentTurns: 1 },
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
        defaults: { maxConcurrentTurns: 0 },
      }),
    ).rejects.toBeInstanceOf(FoomConfigError);
  });
});
