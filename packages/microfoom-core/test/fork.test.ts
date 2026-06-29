// AgentSession.fork() branches the transcript (sketch "Advanced: fork a session").
// fork() returns a new session seeded with a COPY of the parent's transcript so far,
// diverging independently. A harness whose session can't clone its state omits the
// port's fork() and core surfaces FoomConfigError. `.with()` is also covered:
// it layers options onto the SAME transcript (shared session), not a fresh one.

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import {
  CONTROL_TOOLS,
  type HarnessSession,
  type OpenSession,
  Program,
  runProgram,
  type SessionTurnRequest,
  type SessionTurnResult,
  type UsageDelta,
} from "../src/index.ts";
import { makeStandardSchema } from "../src/standard_schema.ts";
import { fakeHarness } from "./fake_session.ts";

const stringInput: StandardSchemaV1<unknown, string> = makeStandardSchema((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);
const numberSchema: StandardSchemaV1<unknown, number> = makeStandardSchema((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);

const USAGE: UsageDelta = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 };

// A harness that models a transcript: each turn appends its prompt to the session's
// history; a value turn returns the running history length so a test can observe how
// many turns a branch has seen. fork() copies the history — the real branch.
function recordingHarness(): OpenSession {
  const makeRecordingSession = (history: string[]): HarnessSession => ({
    async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
      history.push(request.prompt);
      const returnTool = request.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
      if (returnTool !== undefined) {
        await returnTool.execute({ value: history.length });
        return { assistantText: "", usage: USAGE };
      }
      return { assistantText: `len:${history.length}`, usage: USAGE };
    },
    fork: () => makeRecordingSession([...history]),
  });
  return () => makeRecordingSession([]);
}

describe("AgentSession.fork (transcript branching)", () => {
  it("branches from the parent transcript and diverges independently", async () => {
    class P extends Program<typeof stringInput, number[]>(stringInput) {
      async main(): Promise<number[]> {
        const base = this.agent.session();
        await base.prose`A`; // base transcript: [A]
        const f1 = base.fork();
        const f2 = base.fork();
        // Each fork starts from a COPY of [A], adds one turn → length 2, and neither
        // sees the other's turn. The base also stays at length 2 (A + its own).
        const r1 = await f1.value(numberSchema)`B`;
        const r2 = await f2.value(numberSchema)`C`;
        const rb = await base.value(numberSchema)`D`;
        return [r1, r2, rb];
      }
    }
    const out = await runProgram(P, "x", {
      harnesses: { rec: recordingHarness() },
      model: "fake",
    });
    // If fork did NOT copy the transcript (a fresh empty session) this would be
    // [1, 1, 2]; branching makes every value turn see the inherited [A].
    expect(out).toEqual([2, 2, 2]);
  });

  it(".with() layers options onto the SAME transcript, not a fresh session", async () => {
    class W extends Program<typeof stringInput, number>(stringInput) {
      async main(): Promise<number> {
        const session = this.agent.session();
        await session.prose`A`; // [A]
        // .with() must continue the same conversation, so this turn sees [A] → 2.
        return await session.with({ label: "x" }).value(numberSchema)`B`;
      }
    }
    const out = await runProgram(W, "x", { harnesses: { rec: recordingHarness() }, model: "fake" });
    expect(out).toBe(2);
  });

  it("throws FoomConfigError when the harness session can't fork", async () => {
    class Q extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.session().fork().prose`x`;
      }
    }
    // fakeOpenSession has no fork() — branching is unsupported.
    await expect(
      runProgram(Q, "x", { harnesses: fakeHarness([]), model: "fake" }),
    ).rejects.toMatchObject({
      name: "FoomConfigError",
      message: expect.stringContaining("does not support session fork"),
    });
  });
});
