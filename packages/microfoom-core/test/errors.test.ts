import { describe, expect, it } from "vitest";
import {
  FoomtimeCancelledError,
  FoomtimeDispatchError,
  FoomtimeError,
  FoomtimeHarnessRejectedError,
  FoomtimeHarnessUnavailableError,
  FoomtimeRepairExhaustedError,
  FoomtimeThrowError,
  FoomtimeTimeoutError,
} from "../src/index.ts";

describe("error taxonomy (F7)", () => {
  it("reports each subclass's own name and is a FoomtimeError", () => {
    const err = new FoomtimeRepairExhaustedError("gave up", "return");
    expect(err).toBeInstanceOf(FoomtimeError);
    expect(err.name).toBe("FoomtimeRepairExhaustedError");
  });

  it("records on FoomtimeRepairExhaustedError which channel exhausted the loop", () => {
    expect(new FoomtimeRepairExhaustedError("a", "args").channel).toBe("args");
    expect(new FoomtimeRepairExhaustedError("d", "dispatch").channel).toBe("dispatch");
    // An exposed-but-missing implementation is a separate fail-fast defect.
    expect(new FoomtimeDispatchError("missing")).toBeInstanceOf(FoomtimeError);
    expect(new FoomtimeDispatchError("missing")).not.toBeInstanceOf(FoomtimeRepairExhaustedError);
  });

  it("carries the caller-defined code only on FoomtimeThrowError", () => {
    const err = new FoomtimeThrowError("too low", "E_TOO_LOW");
    expect(err.code).toBe("E_TOO_LOW");
    expect(err).toBeInstanceOf(FoomtimeError);
    expect(err).not.toBeInstanceOf(FoomtimeRepairExhaustedError);
  });

  it("splits harness failures by retryability", () => {
    expect(new FoomtimeHarnessUnavailableError("5xx").retryable).toBe(true);
    expect(new FoomtimeHarnessRejectedError("denied").retryable).toBe(false);
  });

  it("nests aborts: timeout and cancel are both FoomtimeAbortError", () => {
    expect(new FoomtimeTimeoutError("slow")).toBeInstanceOf(FoomtimeError);
    const cancelled = new FoomtimeCancelledError("stopped");
    expect(cancelled.name).toBe("FoomtimeCancelledError");
  });

  it("passes through cause and data", () => {
    const cause = new Error("root");
    const err = new FoomtimeError("wrap", { cause, data: { route: "/login" } });
    expect(err.cause).toBe(cause);
    expect(err.data).toEqual({ route: "/login" });
  });
});
