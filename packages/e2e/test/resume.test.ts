// Resume after termination, end to end through the REAL pi harness adapter over a
// faux provider. A program runs once against a FileTurnStore (a temp JSONL file),
// recording each completed turn; a second run shares that store but is given a
// provider seeded with NO responses — so it can only succeed by recalling the stored
// outcomes (the adapter's runTurn is never reached). This proves the store
// short-circuits the model on resume across a fresh adapter/provider, not just in a
// core unit test. Offline and deterministic — runs in `check`.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_TOOLS,
  createFileTurnStore,
  makeStandardSchema,
  Program,
  runProgram,
} from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { piE2EAdapter } from "./support/adapters.ts";
import { callTool } from "./support/script.ts";

const numberSchema = makeStandardSchema<number>((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);
const stringInput = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);

// A two-turn program: two stateless value turns. Both must be recalled on resume.
class TwoStep extends Program<typeof stringInput, number[]>(stringInput) {
  async main(): Promise<number[]> {
    const first = await this.agent.value(numberSchema)`give the first number`;
    const second = await this.agent.value(numberSchema)`give the second number`;
    return [first, second];
  }
}

// A constant model id passed to BOTH runs: the scripted adapter ignores it for
// execution (resolveModel is overridden), but the store fingerprint includes it, so
// the two runs must agree on it to recall.
const MODEL = "faux-resume";

describe("resume after termination — pi adapter over a faux provider", () => {
  it("recalls completed turns on a second run whose provider has no responses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foom-e2e-resume-"));
    const file = join(dir, "turns.jsonl");

    // Run 1: the model answers both value turns; the store records them.
    const live = piE2EAdapter().scripted([
      callTool(CONTROL_TOOLS.return, { value: 11 }),
      callTool(CONTROL_TOOLS.return, { value: 22 }),
    ]);
    const first = await runProgram(TwoStep, "x", {
      harnesses: { pi: live.openSession },
      model: MODEL,
      store: createFileTurnStore(file),
    });
    expect(first).toEqual([11, 22]);

    // Both turns were persisted.
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    // Run 2: a brand-new adapter + provider seeded with NO responses. If the store
    // didn't short-circuit the model, the faux provider would be asked for a reply it
    // doesn't have and the run would throw. Recall makes it succeed with the same
    // result — and the model is never invoked.
    const resumed = piE2EAdapter().scripted([]);
    const second = await runProgram(TwoStep, "x", {
      harnesses: { pi: resumed.openSession },
      model: MODEL,
      store: createFileTurnStore(file),
    });
    expect(second).toEqual([11, 22]);
  });

  it("a re-run WITHOUT a store re-invokes the model (negative control)", async () => {
    // Same shape, but no store on the second run and an empty provider: the model IS
    // reached, has no response, and the run fails — proving the recall in the first
    // test is what makes the no-response provider succeed, not some accident.
    class OneStep extends Program<typeof stringInput, number>(stringInput) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`give a number`;
      }
    }
    const live = piE2EAdapter().scripted([callTool(CONTROL_TOOLS.return, { value: 5 })]);
    expect(
      await runProgram(OneStep, "x", { harnesses: { pi: live.openSession }, model: MODEL }),
    ).toBe(5);

    const empty = piE2EAdapter().scripted([]);
    await expect(
      runProgram(OneStep, "x", { harnesses: { pi: empty.openSession }, model: MODEL }),
    ).rejects.toThrow();
  });
});
