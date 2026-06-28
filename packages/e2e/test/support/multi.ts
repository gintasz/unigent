// The two-adapter subject: ONE program that drives two different harnesses in a
// single run, concurrently, each to its own correct value. This is what proves the
// second adapter coexists with the first — both selectable via the config cascade
// (`this.agent.with({ harness, model })`), both opening their own session, neither
// bleeding into the other. Distinct target values (42 on one harness, 7 on the
// other) make cross-talk observable: if the two turns shared a session or a model,
// the values would collide or mis-route; they don't, so the harnesses are
// independent. Per-turn `harness` AND `model` both route here, so the live tier
// also exercises that a claudecli turn gets a Claude model while the pi turn gets
// the pi model — a mis-thread would send one harness the other's model and fail.

import { makeStandardSchema, type OpenSession, Program, runProgram } from "@microfoom/core";

/** A number validator that also advertises its JSON shape, so a harness that
 *  types foom_return's param (and a live model) returns a number, not the string
 *  "42" — mirroring the real fixtures' withJsonSchema. */
const numberSchema = (() => {
  const schema = makeStandardSchema<number>((input) =>
    typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
  );
  return {
    ...schema,
    "~standard": { ...schema["~standard"], jsonSchema: { input: () => ({ type: "number" }) } },
  };
})();

/** The two models to use, one per harness — supplied per run so the program names
 *  no concrete model (pi resolves an openrouter id; claudecli a Claude alias). */
export interface HarnessModels {
  readonly piModel: string;
  readonly cliModel: string;
}

const modelsSchema = makeStandardSchema<HarnessModels>((input) => {
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as Record<string, unknown>).piModel === "string" &&
    typeof (input as Record<string, unknown>).cliModel === "string"
  ) {
    return { value: input as HarnessModels };
  }
  return { issues: [{ message: "expected { piModel, cliModel }" }] };
});

/** What the two harnesses each returned, kept apart so the caller can prove both
 *  ran and stayed on their own track. */
export interface TwoHarnessResult {
  readonly pi: number;
  readonly claude: number;
}

export class TwoHarnessProgram extends Program<typeof modelsSchema, TwoHarnessResult>(
  modelsSchema,
) {
  async main(models: HarnessModels): Promise<TwoHarnessResult> {
    // Run both harnesses at once: independent sessions, no shared state, distinct
    // targets. Promise.all also makes the two harness loops overlap in wall-clock,
    // so the test would surface any cross-run interference, not just sequential use.
    const [pi, claude] = await Promise.all([
      this.agent
        .with({ harness: "pi", model: models.piModel, label: "pi" })
        .value(numberSchema)`Return the integer 42 via foom_return.`,
      this.agent
        .with({ harness: "claudecli", model: models.cliModel, label: "claudecli" })
        .value(numberSchema)`Return the integer 7 via foom_return.`,
    ]);
    return { pi, claude };
  }
}

/**
 * The two-adapter verdict, factored out so EXACTLY ONE assertion guards every
 * caller — the scripted test, the live test, and the negative control. The
 * negative control feeds it a deliberately-wrong result and requires it to throw,
 * proving this check actually bites (a green suite with a dead assertion is the
 * failure mode this whole exercise exists to kill). Throws on the first mismatch.
 */
export function assertTwoHarness(out: TwoHarnessResult): void {
  if (out.pi !== 42) throw new Error(`pi harness: expected 42, got ${out.pi}`);
  if (out.claude !== 7) throw new Error(`claudecli harness: expected 7, got ${out.claude}`);
}

/** Run the two-harness program once over the given pair of harness sessions. */
export function runTwoHarness(
  piSession: OpenSession,
  cliSession: OpenSession,
  models: HarnessModels,
): Promise<TwoHarnessResult> {
  return runProgram(TwoHarnessProgram, models, {
    harnesses: { pi: piSession, claudecli: cliSession },
    defaultHarness: "pi",
    // A run-level model is required; the per-turn .with({ model }) overrides it for
    // each harness. The claudecli turn must NOT inherit this pi model.
    model: models.piModel,
    defaults: { allowedTools: [] },
  });
}
