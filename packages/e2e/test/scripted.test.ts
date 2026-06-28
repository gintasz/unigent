// Deterministic, offline behavior suite: every fixture's scripted tier driven
// through the real harness adapter over a faux provider. Runs in `check` (no
// network, no credentials, no cost). The same fixtures run against the live model
// in e2e.test.ts.

import { CONTROL_TOOLS } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { adapters, piE2EAdapter } from "./support/adapters.ts";
import { claudecliE2EAdapter } from "./support/claudecli.ts";
import { fixtures } from "./support/fixtures.ts";
import { assertTwoHarness, runTwoHarness } from "./support/multi.ts";
import { callTool } from "./support/script.ts";

for (const adapter of adapters) {
  describe(`microfoom runtime behavior — ${adapter.name} (scripted)`, () => {
    for (const fixture of fixtures) {
      if (!fixture.tiers.includes("scripted")) continue;
      it(fixture.name, async () => {
        await fixture.exec(adapter.scripted(fixture.script), "scripted");
      });
    }
  });
}

// One program, two different adapters at once — the wiring proof (offline). Each
// harness gets its own scripted provider double; selecting both in a single run and
// getting each one's distinct value back shows the registry/cascade routes per
// turn and the two adapters don't share state. The live tier (e2e.test.ts) runs the
// same program against both real harnesses.
describe("two adapters in one program (scripted)", () => {
  it("routes each turn to its own harness and keeps the results apart", async () => {
    const pi = piE2EAdapter().scripted([callTool(CONTROL_TOOLS.return, { value: 42 })]);
    const cli = claudecliE2EAdapter().scripted([callTool(CONTROL_TOOLS.return, { value: 7 })]);
    const out = await runTwoHarness(pi.openSession, cli.openSession, {
      piModel: pi.model,
      cliModel: cli.model,
    });
    assertTwoHarness(out);
  });

  // Negative control: prove assertTwoHarness actually bites. Feed the claudecli
  // harness a WRONG value (999 instead of 7); the result must flow through to
  // out.claude unchanged (so the live/scripted tests really observe the second
  // harness, not a constant) and assertTwoHarness must reject it. Without this, a
  // dead assertion would let a broken harness pass green — the exact failure mode
  // this whole hardening pass exists to eliminate.
  it("the verdict bites: a wrong harness value is caught (negative control)", async () => {
    const pi = piE2EAdapter().scripted([callTool(CONTROL_TOOLS.return, { value: 42 })]);
    const cli = claudecliE2EAdapter().scripted([callTool(CONTROL_TOOLS.return, { value: 999 })]);
    const out = await runTwoHarness(pi.openSession, cli.openSession, {
      piModel: pi.model,
      cliModel: cli.model,
    });
    expect(out.claude).toBe(999); // the second harness's output really reached us…
    expect(() => assertTwoHarness(out)).toThrow(/claudecli harness/); // …and the verdict rejects it
  });
});
