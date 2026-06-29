import { describe, expect, it } from "vitest";
import { runControlAction } from "../src/tui/keys.ts";

// The run-control gating the TUI footer advertises: Ctrl+R aborts an in-flight
// run, plain `r` reruns a settled one, and each is inert in the other state.
describe("runControlAction (TUI abort/rerun gating)", () => {
  it("Ctrl+R aborts only while running", () => {
    expect(runControlAction({ name: "r", ctrl: true }, true)).toBe("abort");
    expect(runControlAction({ name: "r", ctrl: true }, false)).toBeUndefined();
  });

  it("plain r reruns only when the run has settled", () => {
    expect(runControlAction({ name: "r" }, false)).toBe("rerun");
    expect(runControlAction({ name: "r", ctrl: false }, false)).toBe("rerun");
    expect(runControlAction({ name: "r" }, true)).toBeUndefined();
  });

  it("leaves unrelated keys (incl. Ctrl+C and bare modifiers) alone", () => {
    expect(runControlAction({ name: "q" }, true)).toBeUndefined();
    expect(runControlAction({ name: "c", ctrl: true }, true)).toBeUndefined();
    expect(runControlAction({ name: "s" }, false)).toBeUndefined();
    expect(runControlAction({}, true)).toBeUndefined();
  });
});
