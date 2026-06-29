// The stream-drain + result-resolution helpers: prove drainTurnStream feeds decoded
// JSON lines to the handler (skipping noise/blank lines) and resolveTurnResult maps
// a settled reader to a result or the right typed error.

import {
  FoomHarnessRejectedError,
  FoomHarnessUnavailableError,
  type UsageDelta,
} from "@microfoom/core";
import { describe, expect, it } from "vitest";
import type { Json } from "../src/json.ts";
import { drainTurnStream, resolveTurnResult, type TurnError } from "../src/turn.ts";

const USAGE: UsageDelta = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
/** Hoisted so the assertions' regexes aren't re-compiled per call (useTopLevelRegex). */
const STDERR_BOOM = /boom/;
const NO_RESULT = /codex produced no result/;

async function* lines(...items: string[]): AsyncGenerator<string> {
  for (const item of items) {
    yield item;
  }
}

function reader(state: { error?: TurnError; resultSeen?: boolean; assistantText?: string }) {
  return {
    error: () => state.error,
    resultSeen: () => state.resultSeen ?? false,
    assistantText: () => state.assistantText ?? "",
    usage: () => USAGE,
  };
}

describe("drainTurnStream", () => {
  it("decodes JSON lines and skips blanks + non-JSON noise", async () => {
    const seen: Json[] = [];
    await drainTurnStream(
      { lines: lines('{"a":1}', "", "not json", '{"b":2}'), stderr: () => "" },
      (event) => seen.push(event),
    );
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("resolveTurnResult", () => {
  it("returns assistantText + usage on a clean completion", () => {
    const out = resolveTurnResult(
      reader({ resultSeen: true, assistantText: "hi" }),
      { lines: lines(), stderr: () => "" },
      "codex",
    );
    expect(out).toEqual({ assistantText: "hi", usage: USAGE });
  });

  it("maps a retryable error to FoomHarnessUnavailableError", () => {
    expect(() =>
      resolveTurnResult(
        reader({ error: { message: "rate limited", retryable: true } }),
        { lines: lines(), stderr: () => "" },
        "codex",
      ),
    ).toThrow(FoomHarnessUnavailableError);
  });

  it("maps a non-retryable error to FoomHarnessRejectedError", () => {
    expect(() =>
      resolveTurnResult(
        reader({ error: { message: "denied", retryable: false } }),
        { lines: lines(), stderr: () => "" },
        "codex",
      ),
    ).toThrow(FoomHarnessRejectedError);
  });

  it("treats a missing completion as unavailable, surfacing stderr + label", () => {
    expect(() =>
      resolveTurnResult(reader({}), { lines: lines(), stderr: () => "boom" }, "codex"),
    ).toThrow(STDERR_BOOM);
    expect(() =>
      resolveTurnResult(reader({}), { lines: lines(), stderr: () => "" }, "codex"),
    ).toThrow(NO_RESULT);
  });
});
