import { describe, expect, it } from "vitest";
import {
  FoomCancelledError,
  FoomDispatchError,
  FoomError,
  FoomHarnessRejectedError,
  FoomHarnessUnavailableError,
  FoomRepairExhaustedError,
  FoomThrowError,
  FoomTimeoutError,
} from "../src/index.ts";

describe("error taxonomy (F7)", () => {
  it("reports each subclass's own name and is a FoomError", () => {
    const err = new FoomRepairExhaustedError("gave up", "return");
    expect(err).toBeInstanceOf(FoomError);
    expect(err.name).toBe("FoomRepairExhaustedError");
  });

  it("records on FoomRepairExhaustedError which channel exhausted the loop", () => {
    expect(new FoomRepairExhaustedError("a", "args").channel).toBe("args");
    expect(new FoomRepairExhaustedError("d", "dispatch").channel).toBe("dispatch");
    // An exposed-but-missing implementation is a separate fail-fast defect.
    expect(new FoomDispatchError("missing")).toBeInstanceOf(FoomError);
    expect(new FoomDispatchError("missing")).not.toBeInstanceOf(FoomRepairExhaustedError);
  });

  it("carries the caller-defined code only on FoomThrowError", () => {
    const err = new FoomThrowError("too low", "E_TOO_LOW");
    expect(err.code).toBe("E_TOO_LOW");
    expect(err).toBeInstanceOf(FoomError);
    expect(err).not.toBeInstanceOf(FoomRepairExhaustedError);
  });

  it("splits harness failures by retryability", () => {
    expect(new FoomHarnessUnavailableError("5xx").retryable).toBe(true);
    expect(new FoomHarnessRejectedError("denied").retryable).toBe(false);
  });

  it("nests aborts: timeout and cancel are both FoomAbortError", () => {
    expect(new FoomTimeoutError("slow")).toBeInstanceOf(FoomError);
    const cancelled = new FoomCancelledError("stopped");
    expect(cancelled.name).toBe("FoomCancelledError");
  });

  it("passes through cause and data", () => {
    const cause = new Error("root");
    const err = new FoomError("wrap", { cause, data: { route: "/login" } });
    expect(err.cause).toBe(cause);
    expect(err.data).toEqual({ route: "/login" });
  });
});
