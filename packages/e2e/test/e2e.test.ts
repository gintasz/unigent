// Live behavior suite: every fixture's live tier driven through the real harness
// adapter against a real model (resolved from the host's pi config; override with
// MICROFOOM_E2E_MODEL). Excluded from the default `check` run (filename matches the
// vitest e2e exclude); run it with `pnpm test:e2e`.
//
// Skip vs. fail is deliberate: only a harness/provider failure (no credentials,
// connection down) skips — a behavior mismatch is NOT a FoomtimeHarnessError, so a
// real regression in protocol compliance still fails loudly.

import { FoomtimeHarnessError } from "@microfoom/core";
import { describe, it } from "vitest";
import { adapters, piE2EAdapter } from "./support/adapters.ts";
import { claudecliE2EAdapter } from "./support/claudecli.ts";
import { fixtures } from "./support/fixtures.ts";
import { assertTwoHarness, runTwoHarness } from "./support/multi.ts";

for (const adapter of adapters) {
  describe(`microfoom runtime behavior — ${adapter.name} (live)`, () => {
    for (const fixture of fixtures) {
      if (!fixture.tiers.includes("live")) continue;
      it(fixture.name, async () => {
        try {
          await fixture.exec(adapter.live, "live");
        } catch (error) {
          if (error instanceof FoomtimeHarnessError) {
            console.warn(`[live skipped — provider] ${fixture.name}: ${error.message}`);
            return;
          }
          throw error;
        }
      }, 60_000);
    }
  });
}

// The two-adapter proof against the REAL harnesses: one program drives pi and
// claudecli concurrently, each on its own model, each to its own value. Passing
// requires both adapters to coexist in one run — distinct correct results show no
// cross-talk, and per-turn model routing (a Claude alias to claudecli, an
// openrouter id to pi) means a mis-thread would hand one harness the other's model
// and fail. Skips only when a provider is unavailable (same rule as the fixtures).
describe("two adapters in one program (live)", () => {
  it("drives pi and claudecli concurrently, each to its own correct value", async () => {
    const pi = piE2EAdapter().live;
    const cli = claudecliE2EAdapter().live;
    try {
      const out = await runTwoHarness(pi.openSession, cli.openSession, {
        piModel: pi.model,
        cliModel: cli.model,
      });
      assertTwoHarness(out);
    } catch (error) {
      if (error instanceof FoomtimeHarnessError) {
        console.warn(`[live skipped — provider] two-adapter: ${error.message}`);
        return;
      }
      throw error;
    }
  }, 90_000);
});
