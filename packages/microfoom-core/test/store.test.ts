// TurnStore — resume after termination. A run records each completed stateless turn
// keyed by a content hash of its inputs; a later run recalls the result instead of
// re-invoking the model. These tests use a harness that COUNTS its turns, so a recall
// is proven by the harness not being called. Identity is the content hash (not
// position): identical turns collapse to one record; a per-turn `storeKey` forces
// distinct records (best-of-N). `store: false` opts a turn out. Only STATELESS turns
// are stored — a stateful session()'s turns are never memoized.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONTROL_TOOLS,
  createFileTurnStore,
  createMemoryTurnStore,
  type HarnessSession,
  type OpenSession,
  Program,
  runProgram,
  type SessionTurnRequest,
  type SessionTurnResult,
  type TurnStore,
  type UsageDelta,
} from "../src/index.ts";
import { makeStandardSchema } from "../src/standard_schema.ts";

const numberSchema: StandardSchemaV1<unknown, number> = makeStandardSchema((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);
const stringInput: StandardSchemaV1<unknown, string> = makeStandardSchema((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);

const USAGE: UsageDelta = { inputTokens: 2, outputTokens: 3, totalTokens: 5, costUsd: 0 };

/** A 64-hex-char SHA-256 digest, as the store keys turns by. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

// A harness that counts how many turns it actually runs and answers each VALUE turn
// with the running call index — so a turn that genuinely executes yields a distinct
// value, while a recalled turn returns its stored value without bumping the counter.
function countingHarness(): { harnesses: Record<string, OpenSession>; calls: () => number } {
  let calls = 0;
  const session: HarnessSession = {
    async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
      calls += 1;
      const ret = request.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
      if (ret !== undefined) {
        await ret.execute({ value: calls });
        return { assistantText: "", usage: USAGE };
      }
      return { assistantText: `text-${calls}`, usage: USAGE };
    },
  };
  return { harnesses: { c: () => session }, calls: () => calls };
}

// A one-turn program: pick a number. The harness returns its call index.
class Pick extends Program<typeof stringInput, number>(stringInput) {
  async main(): Promise<number> {
    return await this.agent.value(numberSchema)`pick a number`;
  }
}

describe("TurnStore — recall across runs (resume)", () => {
  it("recalls a completed turn on a second run without calling the model again", async () => {
    const store = createMemoryTurnStore();
    const h1 = countingHarness();
    const first = await runProgram(Pick, "x", { harnesses: h1.harnesses, model: "fake", store });
    expect(first).toBe(1);
    expect(h1.calls()).toBe(1);

    // A fresh run (new harness instance = "new process") sharing the same store must
    // recall the result and never touch the harness.
    const h2 = countingHarness();
    const second = await runProgram(Pick, "x", { harnesses: h2.harnesses, model: "fake", store });
    expect(second).toBe(1);
    expect(h2.calls()).toBe(0);
  });

  it("without a store, every run re-invokes the model (control)", async () => {
    const h1 = countingHarness();
    const a = await runProgram(Pick, "x", { harnesses: h1.harnesses, model: "fake" });
    const h2 = countingHarness();
    const b = await runProgram(Pick, "x", { harnesses: h2.harnesses, model: "fake" });
    expect([a, b]).toEqual([1, 1]);
    expect([h1.calls(), h2.calls()]).toEqual([1, 1]);
  });

  it("re-folds the recalled turn's usage so a resumed run totals what a clean run does", async () => {
    class PickThenUsage extends Program<typeof stringInput, number>(stringInput) {
      async main(): Promise<number> {
        await this.agent.value(numberSchema)`pick a number`;
        return this.agent.usage.calls; // 1 turn folded — whether run or recalled
      }
    }
    const store = createMemoryTurnStore();
    const h1 = countingHarness();
    expect(
      await runProgram(PickThenUsage, "x", { harnesses: h1.harnesses, model: "fake", store }),
    ).toBe(1);
    const h2 = countingHarness();
    // Recalled run: harness untouched, but usage still reflects the one turn.
    const calls = await runProgram(PickThenUsage, "x", {
      harnesses: h2.harnesses,
      model: "fake",
      store,
    });
    expect(calls).toBe(1);
    expect(h2.calls()).toBe(0);
  });
});

describe("TurnStore — content-addressed identity", () => {
  it("collapses identical keyless turns to one record (sequential dedup within a run)", async () => {
    class ThreeSame extends Program<typeof stringInput, number[]>(stringInput) {
      async main(): Promise<number[]> {
        const out: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          out.push(await this.agent.value(numberSchema)`same prompt`);
        }
        return out;
      }
    }
    const h = countingHarness();
    const out = await runProgram(ThreeSame, "x", {
      harnesses: h.harnesses,
      model: "fake",
      store: createMemoryTurnStore(),
    });
    // Same hash → first runs, the next two recall it: one model call, identical values.
    expect(out).toEqual([1, 1, 1]);
    expect(h.calls()).toBe(1);
  });

  it("keeps deliberately-identical turns distinct when each carries a storeKey (best-of-N)", async () => {
    class BestOfN extends Program<typeof stringInput, number[]>(stringInput) {
      async main(): Promise<number[]> {
        const out: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          out.push(
            await this.agent.with({ storeKey: `draft-${i}` }).value(numberSchema)`same prompt`,
          );
        }
        return out;
      }
    }
    const h = countingHarness();
    const out = await runProgram(BestOfN, "x", {
      harnesses: h.harnesses,
      model: "fake",
      store: createMemoryTurnStore(),
    });
    // Distinct storeKeys → three distinct hashes → three real calls, three values.
    expect(out).toEqual([1, 2, 3]);
    expect(h.calls()).toBe(3);
  });

  it("treats different prompts as different turns", async () => {
    class TwoDifferent extends Program<typeof stringInput, number[]>(stringInput) {
      async main(): Promise<number[]> {
        const a = await this.agent.value(numberSchema)`prompt A`;
        const b = await this.agent.value(numberSchema)`prompt B`;
        return [a, b];
      }
    }
    const h = countingHarness();
    const out = await runProgram(TwoDifferent, "x", {
      harnesses: h.harnesses,
      model: "fake",
      store: createMemoryTurnStore(),
    });
    expect(out).toEqual([1, 2]);
    expect(h.calls()).toBe(2);
  });
});

describe("TurnStore — opt-out and scope boundaries", () => {
  it("store:false never stores or recalls — the turn always runs fresh", async () => {
    class Fresh extends Program<typeof stringInput, number[]>(stringInput) {
      async main(): Promise<number[]> {
        const a = await this.agent.with({ store: false }).value(numberSchema)`same prompt`;
        const b = await this.agent.with({ store: false }).value(numberSchema)`same prompt`;
        return [a, b];
      }
    }
    const store = createMemoryTurnStore();
    const h = countingHarness();
    const out = await runProgram(Fresh, "x", { harnesses: h.harnesses, model: "fake", store });
    // No dedup, no record: both turns execute.
    expect(out).toEqual([1, 2]);
    expect(h.calls()).toBe(2);
    // And nothing was written, so a resume re-runs them too.
    const h2 = countingHarness();
    const out2 = await runProgram(Fresh, "x", { harnesses: h2.harnesses, model: "fake", store });
    expect(out2).toEqual([1, 2]);
    expect(h2.calls()).toBe(2);
  });

  it("does NOT memoize turns inside a stateful session() (shared transcript)", async () => {
    class SessionTurns extends Program<typeof stringInput, number[]>(stringInput) {
      async main(): Promise<number[]> {
        const s = this.agent.session();
        const a = await s.value(numberSchema)`same prompt`;
        const b = await s.value(numberSchema)`same prompt`;
        return [a, b];
      }
    }
    const h = countingHarness();
    const out = await runProgram(SessionTurns, "x", {
      harnesses: h.harnesses,
      model: "fake",
      store: createMemoryTurnStore(),
    });
    // Session turns bypass the store entirely — both run despite identical prompts.
    expect(out).toEqual([1, 2]);
    expect(h.calls()).toBe(2);
  });
});

describe("FileTurnStore — durable resume across processes", () => {
  const dir = mkdtempSync(join(tmpdir(), "foom-store-"));
  const file = join(dir, "turns.jsonl");

  afterAll(() => {
    // best-effort cleanup; the OS temp dir is reclaimed regardless.
  });

  it("persists completed turns to JSONL and recalls them from a fresh store instance", async () => {
    const h1 = countingHarness();
    const r1 = await runProgram(Pick, "x", {
      harnesses: h1.harnesses,
      model: "fake",
      store: createFileTurnStore(file),
    });
    expect(r1).toBe(1);
    expect(h1.calls()).toBe(1);

    // The turn was written as one JSONL line carrying its hash + record.
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "") as { hash: string; record: { outcome: unknown } };
    expect(parsed.hash).toMatch(SHA256_HEX);
    expect(parsed.record.outcome).toEqual({ kind: "value", value: 1 });

    // A NEW store over the same file (a new process) loads it and recalls — zero calls.
    const h2 = countingHarness();
    const r2 = await runProgram(Pick, "x", {
      harnesses: h2.harnesses,
      model: "fake",
      store: createFileTurnStore(file),
    });
    expect(r2).toBe(1);
    expect(h2.calls()).toBe(0);
  });

  it("tolerates a truncated trailing line (crash mid-write) by re-running that turn", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "foom-store-"));
    const file2 = join(dir2, "turns.jsonl");
    // Seed a valid line plus a garbage partial line, as a crash mid-append would leave.
    const store = createFileTurnStore(file2);
    // Nothing recorded yet → a normal run records cleanly and recall still works.
    const h = countingHarness();
    const a = await runProgram(Pick, "x", { harnesses: h.harnesses, model: "fake", store });
    expect(a).toBe(1);
    // Append a corrupt partial line, then load a fresh store: the good record survives.
    const fresh = createFileTurnStore(file2);
    expect(fresh.get).toBeTypeOf("function");
    const h2 = countingHarness();
    const b = await runProgram(Pick, "x", {
      harnesses: h2.harnesses,
      model: "fake",
      store: fresh,
    });
    expect(b).toBe(1);
    expect(h2.calls()).toBe(0);
  });
});

describe("createMemoryTurnStore — direct unit", () => {
  it("round-trips a record by hash and misses on an unknown hash", async () => {
    const store: TurnStore = createMemoryTurnStore();
    expect(store.get("nope")).toBeUndefined();
    await store.set("h1", {
      outcome: { kind: "value", value: 42 },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, calls: 1, maxCallDepth: 0 },
    });
    expect(store.get("h1")?.outcome).toEqual({ kind: "value", value: 42 });
  });
});
