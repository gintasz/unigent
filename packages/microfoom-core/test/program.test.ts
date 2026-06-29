import { fileURLToPath } from "node:url";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONTROL_TOOLS,
  FoomCancelledError,
  foom,
  type OpenSession,
  Program,
  runProgram,
  type SessionTurnRequest,
  type SessionTurnResult,
} from "../src/index.ts";
import { makeStandardSchema } from "../src/standard_schema.ts";
import { type FakeRound, fakeHarness } from "./fake_session.ts";
import { Calc } from "./fixtures/calc_program.ts";

const numberSchema: StandardSchemaV1<unknown, number> = makeStandardSchema((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);
const stringInput: StandardSchemaV1<unknown, string> = makeStandardSchema((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);

const callRound = (name: string, args: unknown): FakeRound => ({ call: { name, args } });

describe("program facade (end to end, fake session)", () => {
  it("runs a text turn and returns the prose", async () => {
    class Greeter extends Program<typeof stringInput, string>(stringInput) {
      async main(who: string): Promise<string> {
        return await this.agent.prose`Say hi to ${who}.`;
      }
    }
    const out = await runProgram(Greeter, "sam", {
      harnesses: fakeHarness([{ text: "hi sam" }]),
      model: "fake",
    });
    expect(out).toBe("hi sam");
  });

  it("runs a value turn validated against the schema", async () => {
    class Picker extends Program<typeof stringInput, number>(stringInput) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`Pick a number.`;
      }
    }
    const out = await runProgram(Picker, "x", {
      harnesses: fakeHarness([callRound(CONTROL_TOOLS.return, { value: 9 })]),
      model: "fake",
    });
    expect(out).toBe(9);
  });

  it("threads RunProgramOptions.signal: an aborted signal cancels the run with FoomCancelledError", async () => {
    class Picker extends Program<typeof stringInput, number>(stringInput) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`Pick a number.`;
      }
    }
    await expect(
      runProgram(Picker, "x", {
        harnesses: fakeHarness([callRound(CONTROL_TOOLS.return, { value: 9 })]),
        model: "fake",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(FoomCancelledError);
  });

  it("runs a do turn: acts via tools and returns nothing, terminating on a no-arg foom_return", async () => {
    let returnParams: unknown;
    const open: OpenSession = () => ({
      async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
        const ret = request.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
        // The do-turn foom_return takes no arguments (no `value` field).
        returnParams = ret?.parameters;
        await ret?.execute({});
        return {
          assistantText: "",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
        };
      },
    });
    class Doer extends Program<typeof stringInput, void>(stringInput) {
      async main(): Promise<void> {
        await this.agent.do`create the file`;
      }
    }
    const out = await runProgram(Doer, "x", { harnesses: { default: open }, model: "fake" });
    expect(out).toBeUndefined();
    expect(returnParams).toMatchObject({ type: "object", properties: {}, required: [] });
  });

  it("takes the model from class @foom.config when run options omit it", async () => {
    @foom.config({ model: "from-class" })
    class Configured extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.prose`hello`;
      }
    }
    const out = await runProgram(Configured, "x", {
      harnesses: fakeHarness([{ text: "ok" }]),
      model: "fallback",
    });
    expect(out).toBe("ok");
  });

  it("dispatches a foom_call into an exposed method (with derived schema)", async () => {
    const sourceFile = fileURLToPath(new URL("./fixtures/calc_program.ts", import.meta.url));
    const out = await runProgram(Calc, 21, {
      harnesses: fakeHarness([
        callRound(CONTROL_TOOLS.call, { method: "double", arguments: { n: 21 } }),
        callRound(CONTROL_TOOLS.return, { value: 42 }),
      ]),
      model: "fake",
      sourceFile,
      className: "Calc",
    });
    expect(out).toBe(42);
  });

  it("propagates a {tool}-tier method's promptSnippet/promptGuidelines to its native tool def", async () => {
    let toolDefs: SessionTurnRequest["tools"] = [];
    const capturing: OpenSession = () => ({
      async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
        toolDefs = request.tools;
        return {
          assistantText: "done",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      },
    });

    class WithTool extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.prose`go`;
      }
      @foom.expose({
        tool: {
          description: "scores findings",
          promptSnippet: "Use to score a finding count.",
          promptGuidelines: ["Pass a positive count.", "Returns 0 to 100."],
        },
      })
      async score(): Promise<number> {
        return 0;
      }
    }

    await runProgram(WithTool, "x", { harnesses: { default: capturing }, model: "fake" });
    const score = toolDefs.find((tool) => tool.name === "score");
    expect(score?.description).toBe("scores findings");
    expect(score?.promptSnippet).toBe("Use to score a finding count.");
    expect(score?.promptGuidelines).toEqual(["Pass a positive count.", "Returns 0 to 100."]);
  });

  it("advertises the value schema on foom_return and appends the value-turn notice", async () => {
    let request: SessionTurnRequest | undefined;
    const capturing: OpenSession = () => ({
      async runTurn(req: SessionTurnRequest): Promise<SessionTurnResult> {
        request = req;
        const returnTool = req.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
        await returnTool?.execute({ value: { name: "Ada" } });
        return { assistantText: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      },
    });

    const returnShape = z.object({ name: z.string() });
    class P extends Program(stringInput) {
      async main(): Promise<{ name: string }> {
        return await this.agent.value(returnShape)`give a person`;
      }
    }

    await runProgram(P, "x", { harnesses: { default: capturing }, model: "fake" });

    const returnTool = request?.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
    const params = returnTool?.parameters as
      | { properties?: { value?: Record<string, unknown> } }
      | undefined;
    expect(params?.properties?.value).toMatchObject({ type: "object", required: ["name"] });
    expect(request?.prompt).toContain("<!-- microfoom:begin -->");
    expect(request?.prompt).toContain(
      "The user instruction expected you to end this turn with a foom_return tool call passing the result",
    );
    expect(request?.prompt).toContain("foom_throw");
  });

  it("repairs an invalid return then succeeds", async () => {
    class Picker extends Program<typeof stringInput, number>(stringInput) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`Pick.`;
      }
    }
    const out = await runProgram(Picker, "x", {
      harnesses: fakeHarness([
        callRound(CONTROL_TOOLS.return, { value: "not a number" }),
        callRound(CONTROL_TOOLS.return, { value: 5 }),
      ]),
      model: "fake",
    });
    expect(out).toBe(5);
  });

  it("surfaces foom_throw as a thrown FoomThrowError carrying the code", async () => {
    class Thrower extends Program<typeof stringInput, number>(stringInput) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`fail please`;
      }
    }
    await expect(
      runProgram(Thrower, "x", {
        harnesses: fakeHarness([
          callRound(CONTROL_TOOLS.throw, { message: "nope", code: "E_NOPE" }),
        ]),
        model: "fake",
      }),
    ).rejects.toMatchObject({ name: "FoomThrowError", code: "E_NOPE" });
  });

  it("runs a stateful session across turns", async () => {
    class Chat extends Program<typeof stringInput, number>(stringInput) {
      async main(): Promise<number> {
        const session = this.agent.session();
        await session.prose`Explain random numbers.`;
        return await session.value(numberSchema)`Now give one.`;
      }
    }
    const out = await runProgram(Chat, "x", {
      harnesses: fakeHarness([
        { text: "a random number is..." },
        callRound(CONTROL_TOOLS.return, { value: 4 }),
      ]),
      model: "fake",
    });
    expect(out).toBe(4);
  });
});
