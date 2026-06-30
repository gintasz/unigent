import { describe, expect, it } from "vitest";
import {
  FoomCancelledError,
  type HarnessSession,
  makeStandardSchema,
  type OpenSession,
  Program,
  runProgram,
  type SessionTurnRequest,
  type SessionTurnResult,
} from "../src/index.ts";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);

/** A harness whose turn hangs forever and IGNORES request.signal — the worst case
 *  the core abort race must defend against. `started` resolves once the turn is
 *  in-flight (runTurn entered), so a test can abort mid-turn rather than pre-start. */
function hangingHarness(): {
  readonly openSession: OpenSession;
  readonly started: Promise<void>;
  readonly sawSignal: () => AbortSignal | undefined;
} {
  let markStarted: () => void = () => {
    /* replaced once the started promise is constructed */
  };
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let seen: AbortSignal | undefined;
  return {
    openSession: (): HarnessSession => ({
      runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
        seen = request.signal;
        markStarted();
        // Never settles and never honours the signal: only the core race can free
        // the awaiter. If the race is broken, the test hangs and times out.
        return new Promise<SessionTurnResult>(() => {
          /* intentionally never resolves */
        });
      },
    }),
    started,
    sawSignal: () => seen,
  };
}

describe("abort race", () => {
  it("aborts an in-flight turn even when the harness ignores the signal", async () => {
    const harness = hangingHarness();

    class P extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        const turn = this.agent.prose`hang`;
        await harness.started; // let the turn reach runTurn before aborting
        turn.abort();
        return await turn;
      }
    }

    await expect(
      runProgram(P, "x", {
        harnesses: { default: harness.openSession },
        model: "fake",
      }),
    ).rejects.toBeInstanceOf(FoomCancelledError);

    // The signal still reached the harness, so a cooperating adapter could tear
    // the work down (here it deliberately doesn't).
    expect(harness.sawSignal()?.aborted).toBe(true);
  });

  it("aborts before the turn starts (pre-aborted signal short-circuits)", async () => {
    const harness = hangingHarness();

    class P extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        const turn = this.agent.prose`hang`;
        turn.abort();
        return await turn;
      }
    }

    await expect(
      runProgram(P, "x", {
        harnesses: { default: harness.openSession },
        model: "fake",
      }),
    ).rejects.toBeInstanceOf(FoomCancelledError);
  });
});
