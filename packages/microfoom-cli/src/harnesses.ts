// CLI composition root: map user-facing harness names to adapter constructors.
// Program code may select any registered name; the CLI only decides which names
// are available for this execution.

import { createClaudeCliOpenSession } from "@microfoom/claudecli-adapter";
import type { OpenSession } from "@microfoom/core";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import { fakeOpenSession } from "./fake.js";

const HARNESS_OPENERS: Record<string, (omitHarnessPrompt: boolean) => OpenSession> = {
  claudecli: () => createClaudeCliOpenSession(),
  pi: (omitHarnessPrompt: boolean) =>
    createPiOpenSession({ omitHarnessBasePrompt: omitHarnessPrompt }),
  fake: () => fakeOpenSession(),
};

function knownHarnessNames(): readonly string[] {
  return Object.keys(HARNESS_OPENERS);
}

/** Open a session on the named harness, or undefined when the name is unknown. */
function openHarnessSession(
  harnessName: string,
  omitHarnessPrompt: boolean,
): OpenSession | undefined {
  const makeHarness = HARNESS_OPENERS[harnessName];
  return makeHarness?.(omitHarnessPrompt);
}

/** Build a harness registry for one CLI/TUI run.
 *
 * Always expose every CLI-known harness so script-level config can choose any of
 * them. A CLI `--harness` value is validated here, then passed to core as
 * `defaultHarness` by the caller.
 */
function openHarnessRegistry(
  selectedHarness: string | undefined,
  omitHarnessPrompt: boolean,
): Record<string, OpenSession> | undefined {
  if (selectedHarness !== undefined && !knownHarnessNames().includes(selectedHarness)) {
    return;
  }

  const harnesses: Record<string, OpenSession> = {};
  for (const harnessName of knownHarnessNames()) {
    const openSession = openHarnessSession(harnessName, omitHarnessPrompt);
    if (openSession !== undefined) {
      harnesses[harnessName] = openSession;
    }
  }
  return harnesses;
}

export { knownHarnessNames, openHarnessRegistry };
