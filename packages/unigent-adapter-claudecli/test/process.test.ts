import process from "node:process";
import { describe, expect, it } from "vitest";
import { spawnClaude } from "../src/process.ts";

describe("Claude CLI process boundary", () => {
  it("honors a configured binary and bounds captured stderr", async () => {
    const child = spawnClaude(
      ["-e", "process.stderr.write('x'.repeat(100000))"],
      new AbortController().signal,
      "",
      {},
      process.execPath,
    );

    for await (const _line of child.lines) {
      // Drain stdout before checking process completion, matching the adapter lifecycle.
    }
    await child.completion;

    expect(child.stderr()).toHaveLength(65_536);
  });
});
