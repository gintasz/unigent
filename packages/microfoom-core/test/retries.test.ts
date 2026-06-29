// `retries` re-runs a turn on a transient harness failure
// (FoomHarnessUnavailableError) up to the configured count, then gives up.
// Driven by a flaky in-process session that throws N times before succeeding.

import { describe, expect, it } from "vitest";
import {
  FoomHarnessUnavailableError,
  type HarnessSession,
  makeStandardSchema,
  Program,
  runProgram,
  type SessionTurnRequest,
  type SessionTurnResult,
  type UsageDelta,
} from "../src/index.ts";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);
const USAGE: UsageDelta = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 };

/** A session that throws a transient harness error `failsBefore` times, then succeeds. */
function flaky(failsBefore: number): {
  harnesses: Record<string, () => HarnessSession>;
  attempts: () => number;
} {
  let attempts = 0;
  const session: HarnessSession = {
    async runTurn(_request: SessionTurnRequest): Promise<SessionTurnResult> {
      attempts += 1;
      if (attempts <= failsBefore) throw new FoomHarnessUnavailableError("transient");
      return { assistantText: "ok", usage: USAGE };
    },
  };
  return { harnesses: { default: () => session }, attempts: () => attempts };
}

class Echo extends Program<typeof stringSchema, string>(stringSchema) {
  async main(): Promise<string> {
    return await this.agent.prose`go`;
  }
}

describe("retries (transient harness failures)", () => {
  it("re-runs up to `retries` and then succeeds", async () => {
    const { harnesses, attempts } = flaky(2);
    const out = await runProgram(Echo, "x", {
      harnesses,
      model: "m",
      defaults: { tools: [], retries: 2 },
    });
    expect(out).toBe("ok");
    expect(attempts()).toBe(3); // 1 initial + 2 retries
  });

  it("gives up after `retries` and rethrows the harness error", async () => {
    const { harnesses, attempts } = flaky(5);
    await expect(
      runProgram(Echo, "x", { harnesses, model: "m", defaults: { tools: [], retries: 1 } }),
    ).rejects.toBeInstanceOf(FoomHarnessUnavailableError);
    expect(attempts()).toBe(2); // 1 initial + 1 retry
  });

  it("default (no retries) fails on the first transient error", async () => {
    const { harnesses, attempts } = flaky(1);
    await expect(
      runProgram(Echo, "x", { harnesses, model: "m", defaults: { tools: [] } }),
    ).rejects.toBeInstanceOf(FoomHarnessUnavailableError);
    expect(attempts()).toBe(1);
  });
});
