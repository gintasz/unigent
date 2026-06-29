// The orchestration, end to end, offline: real runProgram → real core turn loop →
// real adapter (MCP server, stream parser, session threading) → fake `codex`
// replaying a script against the live MCP server. Only the model + the subprocess
// are fake; everything the adapter actually ships runs here.

import {
  CONTROL_TOOLS,
  FoomRepairExhaustedError,
  makeStandardSchema,
  Program,
  runProgram,
} from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { createCodexCliOpenSession } from "../src/index.ts";
import { type FakeStep, fakeCodexFactory } from "./support/fake_codex.ts";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);
const numberSchema = makeStandardSchema<number>((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);

function harnessFor(steps: readonly FakeStep[]) {
  return {
    openSession: createCodexCliOpenSession({ processFactory: fakeCodexFactory(steps) }),
    model: "gpt-5-codex",
  };
}

describe("codexcli adapter via fake codex (offline)", () => {
  it("maps a text turn through one codex exec invocation", async () => {
    const { openSession, model } = harnessFor([{ kind: "text", text: "hello from codexcli" }]);
    class Greeter extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        return await this.agent.prose`Greet me.`;
      }
    }
    const out = await runProgram(Greeter, "x", {
      harnesses: { codexcli: openSession },
      model,
      defaults: { tools: [] },
    });
    expect(out).toBe("hello from codexcli");
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
      harnesses: { codexcli: openSession },
      model,
      defaults: { tools: [] },
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
      harnesses: { codexcli: openSession },
      model,
      defaults: { tools: [] },
    });
    expect(out).toBe(5);
  });

  it("a value turn with no foom_return raises FoomRepairExhaustedError", async () => {
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
        harnesses: { codexcli: openSession },
        model,
        defaults: { tools: [] },
      }),
    ).rejects.toBeInstanceOf(FoomRepairExhaustedError);
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
      harnesses: { codexcli: openSession },
      model,
      defaults: { tools: [] },
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
      harnesses: { codexcli: openSession },
      model,
      defaults: { tools: [] },
      onEvent: (event) => {
        if (event.type === "span_end") {
          totalTokens += event.usage.totalTokens;
        }
      },
    });
    expect(out).toBe(7);
    expect(totalTokens).toBeGreaterThan(0);
  });
});
