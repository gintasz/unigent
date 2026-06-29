import { FoomHarnessRejectedError } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { splitModel } from "../src/backend.ts";

describe("splitModel", () => {
  it("splits provider from model on the first slash", () => {
    expect(splitModel("openai/gpt-4o-mini")).toEqual({
      providerID: "openai",
      modelID: "gpt-4o-mini",
    });
  });

  it("keeps slashes in the model half", () => {
    expect(splitModel("openrouter/deepseek/deepseek-v4-flash")).toEqual({
      providerID: "openrouter",
      modelID: "deepseek/deepseek-v4-flash",
    });
  });

  it("rejects an id with no provider", () => {
    expect(() => splitModel("gpt-4o-mini")).toThrow(FoomHarnessRejectedError);
    expect(() => splitModel("/leading")).toThrow(FoomHarnessRejectedError);
    expect(() => splitModel("trailing/")).toThrow(FoomHarnessRejectedError);
  });
});
