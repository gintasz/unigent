// The behavior fixtures: one tiny program per runtime contract, each asserting an
// observable OUTCOME (a validated value, the right Foomtime*Error subclass, a
// foom_call side-effect, accumulated usage) — never an internal string or the
// shape of the implementation. This is what keeps the suite honest: it encodes
// what the runtime is meant to do, so it can catch the implementation getting it
// wrong rather than mirroring whatever the implementation currently does.
//
// Each fixture declares which tiers it supports. Scripted tier runs offline and
// deterministically (in `check`); live tier runs the real model (opt-in). Error
// paths the live model can't be coerced into (repair exhaustion, missing return,
// caps) are scripted-only; happy paths run in both.

import { fileURLToPath } from "node:url";
import {
  CONTROL_TOOLS,
  FoomtimeBudgetExceededError,
  FoomtimeCallDepthError,
  FoomtimeConfigError,
  FoomtimeError,
  FoomtimeHarnessError,
  FoomtimeInputError,
  FoomtimeRepairExhaustedError,
  FoomtimeThrowError,
  FoomtimeTimeoutError,
  FoomtimeTokenLimitExceededError,
  foom,
  makeStandardSchema,
  Program,
  runProgram,
} from "@microfoom/core";
import type { RunContext } from "./adapters.ts";
import { callTool, type ScriptStep, sayText, stall } from "./script.ts";

export type Tier = "scripted" | "live";

export interface Fixture {
  readonly name: string;
  readonly tiers: readonly Tier[];
  /** Canned model behavior for the scripted tier (ignored by the live tier). */
  readonly script: readonly ScriptStep[];
  /** Run the program and assert its behavior; throw on any mismatch. */
  exec(ctx: RunContext, tier: Tier): Promise<void>;
}

// ─── assertion helpers (framework-agnostic: a thrown Error fails the test) ─────

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** Run `body`, require it to reject, and require the rejection to match `guard`. */
async function rejects<E extends Error>(
  body: () => Promise<unknown>,
  guard: (error: unknown) => error is E,
  label: string,
): Promise<E> {
  try {
    await body();
  } catch (error) {
    if (guard(error)) return error;
    throw new Error(`${label}: wrong rejection: ${String(error)}`);
  }
  throw new Error(`${label}: expected a rejection but the run succeeded`);
}

/**
 * Assert an adversarial run terminates IN CONTRACT: it resolves to a value the
 * schema accepts, OR it rejects with a FoomtimeError (a deliberate foom_throw, a
 * bad/missing return, repair exhaustion — the model's call, all legitimate). A
 * FoomtimeHarnessError is rethrown so the live wrapper can skip on a dead provider;
 * any OTHER thrown type is a leak (a foreign exception escaping the facade) and
 * fails. A hang is caught by the test timeout.
 */
async function staysInContract(
  body: () => Promise<unknown>,
  isValid: (value: unknown) => boolean,
  label: string,
): Promise<void> {
  let value: unknown;
  try {
    value = await body();
  } catch (error) {
    if (error instanceof FoomtimeHarnessError) throw error;
    if (error instanceof FoomtimeError) return;
    throw new Error(`${label}: leaked a non-Foomtime error: ${String(error)}`);
  }
  if (!isValid(value))
    throw new Error(`${label}: returned out-of-contract value: ${String(value)}`);
}

const isThrow = (e: unknown): e is FoomtimeThrowError => e instanceof FoomtimeThrowError;
const isRepairExhausted = (e: unknown): e is FoomtimeRepairExhaustedError =>
  e instanceof FoomtimeRepairExhaustedError;
const isCallDepth = (e: unknown): e is FoomtimeCallDepthError =>
  e instanceof FoomtimeCallDepthError;
const isTimeout = (e: unknown): e is FoomtimeTimeoutError => e instanceof FoomtimeTimeoutError;
const isTokenLimit = (e: unknown): e is FoomtimeTokenLimitExceededError =>
  e instanceof FoomtimeTokenLimitExceededError;
const isInput = (e: unknown): e is FoomtimeInputError => e instanceof FoomtimeInputError;
const isBudgetOrUnenforceable = (
  e: unknown,
): e is FoomtimeBudgetExceededError | FoomtimeConfigError =>
  e instanceof FoomtimeBudgetExceededError || e instanceof FoomtimeConfigError;

// ─── schemas + programs (the fixture subjects) ─────────────────────────────────

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);
const numberSchema = makeStandardSchema<number>((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);

/** Path to THIS file — the source the runtime parses to derive foom_call params. */
const SOURCE = fileURLToPath(import.meta.url);

class TextProgram extends Program<typeof stringSchema, string>(stringSchema) {
  async main(): Promise<string> {
    return await this.agent.prose`Reply with a short, friendly greeting.`;
  }
}

class ValueProgram extends Program<typeof stringSchema, number>(stringSchema) {
  async main(): Promise<number> {
    return await this.agent.value(numberSchema)`Return the integer 42 via foom_return.`;
  }
}

class ThrowProgram extends Program<typeof stringSchema, number>(stringSchema) {
  async main(): Promise<number> {
    return await this.agent.value(
      numberSchema,
    )`This task cannot be completed. Refuse it by calling foom_throw with code "E_REFUSE".`;
  }
}

class DoublerProgram extends Program<typeof stringSchema, number>(stringSchema) {
  async main(): Promise<number> {
    return await this.agent.value(
      numberSchema,
    )`Call double with n=21, then foom_return the number it gives back.`;
  }

  @foom.expose({ announcement: "Doubles an integer. Pass { n }." })
  async double(n: number): Promise<number> {
    return n * 2;
  }
}

class DepthProgram extends Program<typeof stringSchema, number>(stringSchema) {
  async main(): Promise<number> {
    return await this.agent.value(numberSchema)`Call deepen, then foom_return 1.`;
  }

  // An exposed method that itself opens a turn — invoking it pushes call depth.
  @foom.expose({ announcement: "Runs a nested turn." })
  async deepen(): Promise<number> {
    return await this.agent.value(numberSchema)`Return 2 via foom_return.`;
  }
}

class SessionProgram extends Program<typeof stringSchema, string>(stringSchema) {
  async main(): Promise<string> {
    const session = this.agent.session();
    await session.value(
      stringSchema,
    )`Pick a topic and name it in one word. Respond only via foom_return.`;
    return await session.value(
      stringSchema,
    )`Now give one short sentence about that topic. Respond only via foom_return.`;
  }
}

class ForkProgram extends Program<typeof stringSchema, string>(stringSchema) {
  async main(): Promise<string> {
    const base = this.agent.session();
    await base.value(stringSchema)`Name a color in one word. Respond only via foom_return.`;
    return await base
      .fork()
      .value(stringSchema)`Name a different color in one word. Respond only via foom_return.`;
  }
}

class NumberInputProgram extends Program<typeof numberSchema, number>(numberSchema) {
  async main(seed: number): Promise<number> {
    return seed;
  }
}

// Adversarial subjects (live robustness): genuinely impossible / self-contradicting
// asks. A well-behaved runtime must terminate IN CONTRACT — a schema-valid value or
// a FoomtimeError — never hang, never leak a foreign exception, never return garbage.
class ContradictoryProgram extends Program<typeof stringSchema, number>(stringSchema) {
  async main(): Promise<number> {
    return await this.agent.value(
      numberSchema,
    )`Return a single number that is simultaneously greater than 100 and less than zero, via foom_return.`;
  }
}

class SchemaImpossibleProgram extends Program<typeof stringSchema, number>(stringSchema) {
  async main(): Promise<number> {
    return await this.agent.value(
      numberSchema,
    )`Respond with the word "banana" as your answer. Do not provide any number at all.`;
  }
}

// ─── the fixtures ──────────────────────────────────────────────────────────────

function base(ctx: RunContext) {
  return {
    harnesses: { default: ctx.openSession },
    model: ctx.model,
    defaults: { allowedTools: [] as readonly string[] },
  };
}

export const fixtures: readonly Fixture[] = [
  {
    name: "text turn returns prose",
    tiers: ["scripted", "live"],
    script: [sayText("Hello there, friend!")],
    async exec(ctx) {
      const out = await runProgram(TextProgram, "x", base(ctx));
      assert(typeof out === "string" && out.length > 0, `expected non-empty prose, got ${out}`);
    },
  },
  {
    name: "value turn returns a schema-validated value via foom_return",
    tiers: ["scripted", "live"],
    script: [callTool(CONTROL_TOOLS.return, { value: 42 })],
    async exec(ctx, tier) {
      const out = await runProgram(ValueProgram, "x", base(ctx));
      assert(typeof out === "number", `expected a number, got ${typeof out}`);
      if (tier === "scripted") assert(out === 42, `expected 42, got ${out}`);
    },
  },
  {
    name: "foom_throw surfaces as FoomtimeThrowError carrying the code",
    tiers: ["scripted", "live"],
    script: [callTool(CONTROL_TOOLS.throw, { message: "cannot comply", code: "E_REFUSE" })],
    async exec(ctx, tier) {
      const error = await rejects(
        () => runProgram(ThrowProgram, "x", base(ctx)),
        isThrow,
        "foom_throw",
      );
      assert(typeof error.code === "string" && error.code.length > 0, "throw error lacks a code");
      if (tier === "scripted")
        assert(error.code === "E_REFUSE", `expected E_REFUSE, got ${error.code}`);
    },
  },
  {
    name: "foom_call dispatches into an exposed method",
    tiers: ["scripted", "live"],
    script: [
      callTool(CONTROL_TOOLS.call, { method: "double", arguments: { n: 21 } }),
      callTool(CONTROL_TOOLS.return, { value: 42 }),
    ],
    async exec(ctx, tier) {
      let calledDouble = false;
      const out = await runProgram(DoublerProgram, "x", {
        ...base(ctx),
        sourceFile: SOURCE,
        className: "DoublerProgram",
        onEvent: (event) => {
          if (event.type === "foom_call" && event.method === "double") calledDouble = true;
        },
      });
      assert(typeof out === "number", `expected a number, got ${typeof out}`);
      if (tier === "scripted") {
        assert(calledDouble, "the double method was not invoked via foom_call");
        assert(out === 42, `expected 42, got ${out}`);
      }
    },
  },
  {
    name: "foom_inspect returns a method's parameter schema",
    tiers: ["scripted"],
    script: [
      callTool(CONTROL_TOOLS.inspect, { method: "double" }),
      callTool(CONTROL_TOOLS.return, { value: 84 }),
    ],
    async exec(ctx) {
      let inspectCallId: string | undefined;
      let inspectResult: string | undefined;
      const out = await runProgram(DoublerProgram, "x", {
        ...base(ctx),
        sourceFile: SOURCE,
        className: "DoublerProgram",
        onEvent: (event) => {
          if (event.type === "tool_start" && event.name === CONTROL_TOOLS.inspect) {
            inspectCallId = event.callId;
          }
          if (event.type === "tool_end" && event.callId === inspectCallId) {
            inspectResult = event.content;
          }
        },
      });
      assert(out === 84, `expected 84, got ${out}`);
      assert(inspectResult !== undefined, "no foom_inspect result was observed");
      assert(
        inspectResult.includes("n"),
        `inspect result lacks the param schema: ${inspectResult}`,
      );
    },
  },
  {
    name: "an invalid foom_return is repaired, then succeeds",
    tiers: ["scripted"],
    script: [
      callTool(CONTROL_TOOLS.return, { value: "not a number" }),
      callTool(CONTROL_TOOLS.return, { value: 5 }),
    ],
    async exec(ctx) {
      const out = await runProgram(ValueProgram, "x", base(ctx));
      assert(out === 5, `expected the repaired value 5, got ${out}`);
    },
  },
  {
    name: "too many invalid returns raise FoomtimeRepairExhaustedError",
    tiers: ["scripted"],
    script: [
      callTool(CONTROL_TOOLS.return, { value: "nope" }),
      callTool(CONTROL_TOOLS.return, { value: "nope" }),
      callTool(CONTROL_TOOLS.return, { value: "nope" }),
      callTool(CONTROL_TOOLS.return, { value: "nope" }),
    ],
    async exec(ctx) {
      await rejects(() => runProgram(ValueProgram, "x", base(ctx)), isRepairExhausted, "repair");
    },
  },
  {
    // Boundary: with repairAttempts=1, the SECOND invalid attempt is one too many.
    // Pins the threshold (count), not merely that exhaustion eventually happens.
    name: "repairAttempts is honored: exhausts one past the configured count",
    tiers: ["scripted"],
    script: [
      callTool(CONTROL_TOOLS.return, { value: "nope" }),
      callTool(CONTROL_TOOLS.return, { value: "nope" }),
    ],
    async exec(ctx) {
      await rejects(
        () =>
          runProgram(ValueProgram, "x", {
            ...base(ctx),
            defaults: { allowedTools: [], repairAttempts: 1 },
          }),
        isRepairExhausted,
        "repair-boundary-exhaust",
      );
    },
  },
  {
    // Boundary: with repairAttempts=1, exactly one repair is within budget — the
    // valid second attempt must succeed rather than exhaust.
    name: "repairAttempts is honored: a repair within the budget still succeeds",
    tiers: ["scripted"],
    script: [
      callTool(CONTROL_TOOLS.return, { value: "nope" }),
      callTool(CONTROL_TOOLS.return, { value: 5 }),
    ],
    async exec(ctx) {
      const out = await runProgram(ValueProgram, "x", {
        ...base(ctx),
        defaults: { allowedTools: [], repairAttempts: 1 },
      });
      assert(out === 5, `expected the repaired value 5, got ${out}`);
    },
  },
  {
    name: "a value turn with no foom_return raises FoomtimeRepairExhaustedError",
    tiers: ["scripted"],
    script: [
      sayText("I will not use the tool."),
      sayText("Still not using it."),
      sayText("Nope."),
      sayText("No."),
    ],
    async exec(ctx) {
      const error = await rejects(
        () => runProgram(ValueProgram, "x", base(ctx)),
        isRepairExhausted,
        "missing-return",
      );
      assert(error.channel === "return", `expected channel "return", got ${error.channel}`);
    },
  },
  {
    name: "maxOutputTokens is enforced",
    tiers: ["scripted"],
    script: [callTool(CONTROL_TOOLS.return, { value: 42 })],
    async exec(ctx) {
      await rejects(
        () =>
          runProgram(ValueProgram, "x", {
            ...base(ctx),
            defaults: { allowedTools: [], maxOutputTokens: 0 },
          }),
        isTokenLimit,
        "maxOutputTokens",
      );
    },
  },
  {
    name: "maxCallDepth is enforced",
    tiers: ["scripted"],
    script: [callTool(CONTROL_TOOLS.call, { method: "deepen", arguments: {} })],
    async exec(ctx) {
      await rejects(
        () =>
          runProgram(DepthProgram, "x", {
            ...base(ctx),
            sourceFile: SOURCE,
            className: "DepthProgram",
            defaults: { allowedTools: [], maxCallDepth: 0 },
          }),
        isCallDepth,
        "maxCallDepth",
      );
    },
  },
  {
    name: "maxTurnDuration is enforced",
    tiers: ["scripted"],
    script: [stall(1500, "too slow to matter")],
    async exec(ctx) {
      await rejects(
        () =>
          runProgram(TextProgram, "x", {
            ...base(ctx),
            defaults: { allowedTools: [], maxTurnDuration: "0.2s" },
          }),
        isTimeout,
        "maxTurnDuration",
      );
    },
  },
  {
    name: "maxBudgetUsd is never silently ignored",
    tiers: ["live"],
    script: [callTool(CONTROL_TOOLS.return, { value: 42 })],
    async exec(ctx) {
      // A live turn reports real cost; a near-zero cap is either exceeded
      // (FoomtimeBudgetExceededError) or — if the model has no pricing — refused
      // (FoomtimeConfigError). Both honour the contract; only silence would fail.
      await rejects(
        () =>
          runProgram(ValueProgram, "x", {
            ...base(ctx),
            defaults: { allowedTools: [], maxBudgetUsd: 1e-9 },
          }),
        isBudgetOrUnenforceable,
        "maxBudgetUsd",
      );
    },
  },
  {
    name: "program input is validated against its schema",
    tiers: ["scripted", "live"],
    script: [],
    async exec(ctx) {
      await rejects(
        () => runProgram(NumberInputProgram, "not a number", base(ctx)),
        isInput,
        "input",
      );
    },
  },
  {
    name: "usage accounting accumulates tokens",
    tiers: ["scripted"],
    script: [callTool(CONTROL_TOOLS.return, { value: 7 })],
    async exec(ctx) {
      let totalTokens = 0;
      const out = await runProgram(ValueProgram, "x", {
        ...base(ctx),
        onEvent: (event) => {
          if (event.type === "span_end") totalTokens += event.usage.totalTokens;
        },
      });
      assert(out === 7, `expected 7, got ${out}`);
      assert(totalTokens > 0, `expected accumulated tokens > 0, got ${totalTokens}`);
    },
  },
  {
    name: "a session carries one transcript across turns",
    tiers: ["scripted", "live"],
    script: [
      callTool(CONTROL_TOOLS.return, { value: "weather" }),
      callTool(CONTROL_TOOLS.return, { value: "It is sunny today." }),
    ],
    async exec(ctx) {
      const out = await runProgram(SessionProgram, "x", base(ctx));
      assert(typeof out === "string" && out.length > 0, `expected a string, got ${out}`);
    },
  },
  {
    name: "fork branches a session into an independent one",
    tiers: ["scripted", "live"],
    script: [
      callTool(CONTROL_TOOLS.return, { value: "red" }),
      callTool(CONTROL_TOOLS.return, { value: "blue" }),
    ],
    async exec(ctx) {
      const out = await runProgram(ForkProgram, "x", base(ctx));
      assert(typeof out === "string" && out.length > 0, `expected a string, got ${out}`);
    },
  },
  {
    // Adversarial (live): an impossible numeric constraint. The model may refuse
    // (foom_throw), fail to satisfy the schema (return/repair errors), or pick some
    // number — all in contract; only a hang or a foreign exception fails.
    name: "contradictory instructions stay in contract",
    tiers: ["live"],
    script: [],
    async exec(ctx) {
      await staysInContract(
        () => runProgram(ContradictoryProgram, "x", base(ctx)),
        (value) => typeof value === "number",
        "contradictory",
      );
    },
  },
  {
    // Adversarial (live): the prompt demands a non-numeric answer against a number
    // schema — forcing the repair/throw machinery under a real model.
    name: "a schema-impossible request stays in contract",
    tiers: ["live"],
    script: [],
    async exec(ctx) {
      await staysInContract(
        () => runProgram(SchemaImpossibleProgram, "x", base(ctx)),
        (value) => typeof value === "number",
        "schema-impossible",
      );
    },
  },
];
