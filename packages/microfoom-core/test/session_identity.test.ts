// A session's identity (model, harness, system prompt, omit-base, skills, plugins) is
// FROZEN when session() opens. Two guarantees are pinned here:
//   1. The freeze: no scope applied after open — neither a later method's @foom.config
//      (the "side door") nor a per-turn .with() — can drift a session turn's system
//      prompt. Without this, pi re-applies the changed prompt while claudecli silently
//      keeps the original via --resume: the same script diverges per harness.
//   2. The guard: a .with({ <locked field> }) ON a session handle is a typed error,
//      turning today's silent no-op into a loud one. Stateless this.agent turns open a
//      fresh session each, so they stay free to vary everything (the negative control).

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import {
  type AgentSession,
  CONTROL_TOOLS,
  FoomConfigError,
  foom,
  type HarnessSession,
  type OpenSession,
  Program,
  runProgram,
  type SessionTurnRequest,
  type SessionTurnResult,
  type UsageDelta,
} from "../src/index.ts";
import { makeStandardSchema } from "../src/standard_schema.ts";

const stringInput: StandardSchemaV1<unknown, string> = makeStandardSchema((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);
const numberSchema: StandardSchemaV1<unknown, number> = makeStandardSchema((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);

const USAGE: UsageDelta = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 };

type Round = { readonly call: { name: string; args: unknown } } | { readonly text: string };
const call = (name: string, args: unknown): Round => ({ call: { name, args } });

/** A harness that records the exact system prompt handed to each turn (in order),
 *  replaying one flat script across every turn of the run via FOOM tool handlers. */
function recordingOpenSession(prompts: string[], script: readonly Round[]): OpenSession {
  let cursor = 0;
  const session: HarnessSession = {
    async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
      prompts.push(request.systemPrompt);
      while (cursor < script.length) {
        const round = script[cursor];
        cursor += 1;
        if (round === undefined) break;
        if ("text" in round) return { assistantText: round.text, usage: USAGE };
        const tool = request.tools.find((candidate) => candidate.name === round.call.name);
        if (tool === undefined) return { assistantText: "", usage: USAGE };
        const result = await tool.execute(round.call.args);
        if (result.terminate === true) return { assistantText: "", usage: USAGE };
      }
      return { assistantText: "", usage: USAGE };
    },
  };
  return () => session;
}

describe("session identity is frozen at open (the methodConfig side door)", () => {
  it("a method's @foom.config systemPrompt does NOT leak into a session turn run from inside it", async () => {
    // main opens a session as "ALICE", then a STATELESS `do` turn dispatches deepReview;
    // while deepReview is dispatched (its method config live), it runs a turn on the SAME
    // Alice session. That turn must keep ALICE — not absorb deepReview's "EXHAUSTIVE".
    @foom.config({ systemPrompt: { replace: "ALICE" } })
    class P extends Program<typeof stringInput, string>(stringInput) {
      private session!: AgentSession;

      async main(): Promise<string> {
        this.session = this.agent.session();
        await this.session.prose`turn1`; // session turn — prompts[0]
        await this.agent.do`dispatch deepReview`; // stateless turn — prompts[1]
        await this.session.prose`turn3`; // session turn — prompts[3]
        return "done";
      }

      @foom.config({ systemPrompt: { append: "EXHAUSTIVE" } })
      @foom.expose
      async deepReview(): Promise<void> {
        await this.session.prose`turn2`; // session turn run with methodConfig live — prompts[2]
      }
    }

    const prompts: string[] = [];
    const script: Round[] = [
      { text: "t1" }, // turn1
      call(CONTROL_TOOLS.call, { method: "deepReview", arguments: {} }), // do turn dispatches deepReview
      { text: "t2" }, // turn2 (inside deepReview)
      call(CONTROL_TOOLS.return, {}), // do turn terminates
      { text: "t3" }, // turn3
    ];

    const out = await runProgram(P, "x", {
      harnesses: { rec: recordingOpenSession(prompts, script) },
      model: "fake",
    });
    expect(out).toBe("done");

    // prompts: [turn1, doTurn, turn2, turn3]. The three SESSION turns (0, 2, 3) are byte-
    // identical and frozen as ALICE; none absorbed the method's EXHAUSTIVE append.
    expect(prompts).toHaveLength(4);
    const [turn1, , turn2, turn3] = prompts;
    expect(turn1).toContain("ALICE");
    expect(turn2).toBe(turn1);
    expect(turn3).toBe(turn1);
    expect(turn2).not.toContain("EXHAUSTIVE");
  });

  it("the freeze is targeted: a STATELESS turn inside the method still picks up its scope", async () => {
    // The negative control — method scope must STILL apply to a fresh (stateless) turn,
    // proving we froze sessions specifically, not the cascade everywhere.
    @foom.config({ systemPrompt: { replace: "ALICE" } })
    class P extends Program<typeof stringInput, number>(stringInput) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`go`; // dispatches deepReview, returns 1
      }

      @foom.config({ systemPrompt: { append: "EXHAUSTIVE" } })
      @foom.expose
      async deepReview(): Promise<number> {
        return await this.agent.value(numberSchema)`nested`; // STATELESS — should see EXHAUSTIVE
      }
    }

    const prompts: string[] = [];
    const script: Round[] = [
      call(CONTROL_TOOLS.call, { method: "deepReview", arguments: {} }), // main's turn dispatches
      call(CONTROL_TOOLS.return, { value: 1 }), // deepReview's stateless turn returns
      call(CONTROL_TOOLS.return, { value: 0 }), // main's turn returns
    ];

    await runProgram(P, "x", {
      harnesses: { rec: recordingOpenSession(prompts, script) },
      model: "fake",
    });

    // prompts: [mainTurn (ALICE), deepReview's stateless turn (ALICE + EXHAUSTIVE)].
    expect(prompts[0]).not.toContain("EXHAUSTIVE");
    expect(prompts[1]).toContain("EXHAUSTIVE");
  });
});

describe("session.with() guard (locked identity fields)", () => {
  const lockedCases: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["model", { model: "other/model" }],
    ["harness", { harness: "other" }],
    ["systemPrompt", { systemPrompt: { replace: "BOB" } }],
    ["omitHarnessBasePrompt", { omitHarnessBasePrompt: true }],
    ["skills", { skills: ["x"] }],
    ["plugins", { plugins: ["y"] }],
  ];

  for (const [field, override] of lockedCases) {
    it(`rejects .with({ ${field} }) on a session with FoomConfigError`, async () => {
      class P extends Program<typeof stringInput, string>(stringInput) {
        async main(): Promise<string> {
          // The .with() itself throws synchronously when building the handle.
          return await this.agent.session().with(override).prose`go`;
        }
      }
      const run = runProgram(P, "x", {
        harnesses: { rec: recordingOpenSession([], [{ text: "ok" }]) },
        model: "fake",
      });
      await expect(run).rejects.toBeInstanceOf(FoomConfigError);
      await expect(run).rejects.toThrow(field); // the message names the offending field
    });
  }

  it("allows per-turn fields (thinking, tools, label) on a session .with()", async () => {
    const prompts: string[] = [];
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        const session = this.agent.session();
        return await session.with({ thinking: "high", tools: ["read"], label: "step" }).prose`go`;
      }
    }
    // Must NOT throw — these are free to vary mid-session.
    const out = await runProgram(P, "x", {
      harnesses: { rec: recordingOpenSession(prompts, [{ text: "ok" }]) },
      model: "fake",
    });
    expect(out).toBe("ok");
    expect(prompts).toHaveLength(1);
  });
});
