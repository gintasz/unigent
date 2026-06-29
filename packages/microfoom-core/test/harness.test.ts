// Per-agent harness selection (multi-harness in one program). `harness` rides the
// same cascade as `model` (default → class → method → call); the run carries a
// named registry of OpenSession ports, resolved at session-open. The runtime never
// guesses a positional default — an unselected/unknown harness is a typed error.

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { CONTROL_TOOLS, foom, Program, runProgram } from "../src/index.ts";
import { makeStandardSchema } from "../src/standard_schema.ts";
import { fakeOpenSession } from "./fake_session.ts";

const stringInput: StandardSchemaV1<unknown, string> = makeStandardSchema((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);
const numberSchema: StandardSchemaV1<unknown, number> = makeStandardSchema((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);

const callRound = (name: string, args: unknown) => ({ call: { name, args } });

// Two harnesses whose text turns echo their own identity, so the returned prose
// tells us which port actually ran.
const labelled = () => ({
  a: fakeOpenSession([{ text: "from-a" }]),
  b: fakeOpenSession([{ text: "from-b" }]),
});

describe("harness selection (cascade + registry resolution)", () => {
  it("routes a per-call .with({ harness }) to the named port, over the default", async () => {
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.with({ harness: "b" }).prose`go`;
      }
    }
    const out = await runProgram(P, "x", {
      harnesses: labelled(),
      defaultHarness: "a",
      model: "fake",
    });
    expect(out).toBe("from-b");
  });

  it("uses defaultHarness when no narrower scope selects one", async () => {
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.prose`go`;
      }
    }
    const out = await runProgram(P, "x", {
      harnesses: labelled(),
      defaultHarness: "b",
      model: "fake",
    });
    expect(out).toBe("from-b");
  });

  it("treats a sole registered harness as the default (no defaultHarness needed)", async () => {
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.prose`go`;
      }
    }
    const out = await runProgram(P, "x", {
      harnesses: { only: fakeOpenSession([{ text: "sole" }]) },
      model: "fake",
    });
    expect(out).toBe("sole");
  });

  it("honors a class-level @foom.config({ harness })", async () => {
    @foom.config({ harness: "b" })
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.prose`go`;
      }
    }
    // No defaultHarness, two harnesses: the class config is the only selector.
    const out = await runProgram(P, "x", { harnesses: labelled(), model: "fake" });
    expect(out).toBe("from-b");
  });

  it("honors a per-method @foom.config({ harness }) for turns that method makes", async () => {
    // main runs on "main"; its turn foom_calls `sub`, which (while dispatched, so
    // its method config is live) opens its own value turn on the "sub" harness.
    class Orchestrator extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.prose`delegate`;
      }

      @foom.expose()
      @foom.config({ harness: "sub" })
      async sub(): Promise<number> {
        return await this.agent.value(numberSchema)`pick`;
      }
    }
    const harnesses = {
      main: fakeOpenSession([
        callRound(CONTROL_TOOLS.call, { method: "sub", arguments: {} }),
        { text: "main-done" },
      ]),
      sub: fakeOpenSession([callRound(CONTROL_TOOLS.return, { value: 42 })]),
    };
    const out = await runProgram(Orchestrator, "x", {
      harnesses,
      defaultHarness: "main",
      model: "fake",
    });
    expect(out).toBe("main-done");
  });

  it("rejects an unknown harness name with a typed config error", async () => {
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.with({ harness: "nope" }).prose`go`;
      }
    }
    await expect(
      runProgram(P, "x", { harnesses: { a: fakeOpenSession([{ text: "x" }]) }, model: "fake" }),
    ).rejects.toMatchObject({
      name: "FoomConfigError",
      message: expect.stringContaining('unknown harness "nope"'),
    });
  });

  it("rejects when several harnesses are registered but none is selected", async () => {
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.prose`go`;
      }
    }
    await expect(
      runProgram(P, "x", { harnesses: labelled(), model: "fake" }),
    ).rejects.toMatchObject({
      name: "FoomConfigError",
      message: expect.stringContaining("no harness selected"),
    });
  });

  it("rejects an empty harness registry at setup", async () => {
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.prose`go`;
      }
    }
    await expect(runProgram(P, "x", { harnesses: {}, model: "fake" })).rejects.toMatchObject({
      name: "FoomConfigError",
      message: expect.stringContaining("no harnesses registered"),
    });
  });

  it("rejects a defaultHarness that is not in the registry", async () => {
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.prose`go`;
      }
    }
    await expect(
      runProgram(P, "x", {
        harnesses: { a: fakeOpenSession([{ text: "x" }]) },
        defaultHarness: "b",
        model: "fake",
      }),
    ).rejects.toMatchObject({
      name: "FoomConfigError",
      message: expect.stringContaining("not a registered harness"),
    });
  });
});
