// The orchestration, end to end, offline: real runProgram → real core turn loop →
// real adapter (rename, MCP server, stream parser, session threading) → fake
// `claude` replaying a script against the live MCP server. Only the model + the
// subprocess are fake; everything the adapter actually ships runs here.

import {
  CONTROL_TOOLS,
  FoomtimeRepairExhaustedError,
  makeStandardSchema,
  Program,
  runProgram,
} from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { createClaudeCliOpenSession } from "../src/index.ts";
import { type FakeStep, fakeClaudeFactory } from "./support/fake_claude.ts";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);
const numberSchema = makeStandardSchema<number>((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);

function harnessFor(steps: readonly FakeStep[]) {
  return {
    openSession: createClaudeCliOpenSession({ processFactory: fakeClaudeFactory(steps) }),
    model: "sonnet",
  };
}

describe("claudecli adapter via fake claude (offline)", () => {
  it("maps a text turn through one claude -p invocation", async () => {
    const { openSession, model } = harnessFor([{ kind: "text", text: "hello from claudecli" }]);
    class Greeter extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        return await this.agent.prose`Greet me.`;
      }
    }
    const out = await runProgram(Greeter, "x", {
      harnesses: { claudecli: openSession },
      model,
      defaults: { allowedTools: [] },
    });
    expect(out).toBe("hello from claudecli");
  });

  it("maps a value turn (foom_return) and validates the captured value", async () => {
    const { openSession, model } = harnessFor([
      { kind: "toolCall", name: CONTROL_TOOLS.return, args: { value: 42 } },
    ]);
    class Picker extends Program<typeof stringSchema, number>(stringSchema) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`Pick a number.`;
      }
    }
    const out = await runProgram(Picker, "x", {
      harnesses: { claudecli: openSession },
      model,
      defaults: { allowedTools: [] },
    });
    expect(out).toBe(42);
  });

  it("repairs an invalid foom_return then succeeds", async () => {
    const { openSession, model } = harnessFor([
      { kind: "toolCall", name: CONTROL_TOOLS.return, args: { value: "not a number" } },
      { kind: "toolCall", name: CONTROL_TOOLS.return, args: { value: 5 } },
    ]);
    class Picker extends Program<typeof stringSchema, number>(stringSchema) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`Pick a number.`;
      }
    }
    const out = await runProgram(Picker, "x", {
      harnesses: { claudecli: openSession },
      model,
      defaults: { allowedTools: [] },
    });
    expect(out).toBe(5);
  });

  it("a value turn with no foom_return raises FoomtimeRepairExhaustedError", async () => {
    const { openSession, model } = harnessFor([
      { kind: "text", text: "I refuse the tool." },
      { kind: "text", text: "Still refusing." },
      { kind: "text", text: "No." },
      { kind: "text", text: "Nope." },
    ]);
    class Picker extends Program<typeof stringSchema, number>(stringSchema) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`Pick a number.`;
      }
    }
    await expect(
      runProgram(Picker, "x", {
        harnesses: { claudecli: openSession },
        model,
        defaults: { allowedTools: [] },
      }),
    ).rejects.toBeInstanceOf(FoomtimeRepairExhaustedError);
  });

  it("fork() branches a session into an independent one", async () => {
    const { openSession, model } = harnessFor([
      { kind: "toolCall", name: CONTROL_TOOLS.return, args: { value: "red" } },
      { kind: "toolCall", name: CONTROL_TOOLS.return, args: { value: "blue" } },
    ]);
    class ForkProgram extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        const base = this.agent.session();
        await base.value(stringSchema)`Name a color.`;
        return await base.fork().value(stringSchema)`Name a different color.`;
      }
    }
    const out = await runProgram(ForkProgram, "x", {
      harnesses: { claudecli: openSession },
      model,
      defaults: { allowedTools: [] },
    });
    expect(out).toBe("blue");
  });

  it("accumulates usage across the run", async () => {
    const { openSession, model } = harnessFor([
      { kind: "toolCall", name: CONTROL_TOOLS.return, args: { value: 7 } },
    ]);
    class Picker extends Program<typeof stringSchema, number>(stringSchema) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`Pick a number.`;
      }
    }
    let totalTokens = 0;
    const out = await runProgram(Picker, "x", {
      harnesses: { claudecli: openSession },
      model,
      defaults: { allowedTools: [] },
      onEvent: (event) => {
        if (event.type === "span_end") totalTokens += event.usage.totalTokens;
      },
    });
    expect(out).toBe(7);
    expect(totalTokens).toBeGreaterThan(0);
  });
});
