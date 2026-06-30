import { FoomConfigError, foom, Program, runProgram } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { knownHarnessNames, openHarnessRegistry } from "../src/harnesses.ts";

const inputSchema = z.string();

describe("CLI harness selection", () => {
  it("bundles every manually registered CLI harness", () => {
    expect(knownHarnessNames().toSorted()).toEqual(["claudecli", "fake", "pi"]);
  });

  it("lets a script select a harness when the CLI omits --harness", async () => {
    @foom.config({ harness: "fake" })
    class ScriptSelectedHarness extends Program(inputSchema) {
      async main(input: string): Promise<string> {
        return await this.agent.prose`script selected ${input}`;
      }
    }

    const harnesses = openHarnessRegistry(undefined, false);

    if (harnesses === undefined) {
      throw new Error("expected known CLI harnesses to open");
    }
    await expect(
      runProgram(ScriptSelectedHarness, "Ada", {
        harnesses,
        model: "fake",
      }),
    ).resolves.toContain("fake reply for: script selected Ada");
  });

  it("lets the CLI select a default harness when the script omits harness config", async () => {
    class CliSelectedHarness extends Program(inputSchema) {
      async main(input: string): Promise<string> {
        return await this.agent.prose`cli selected ${input}`;
      }
    }

    const harnesses = openHarnessRegistry("fake", false);

    if (harnesses === undefined) {
      throw new Error("expected fake harness to open");
    }
    expect(Object.keys(harnesses).toSorted()).toEqual(["claudecli", "fake", "pi"]);
    await expect(
      runProgram(CliSelectedHarness, "Ada", {
        harnesses,
        defaultHarness: "fake",
        model: "fake",
      }),
    ).resolves.toContain("fake reply for: cli selected Ada");
  });

  it("lets script config override the CLI default harness", async () => {
    @foom.config({ harness: "fake" })
    class ScriptOverrideHarness extends Program(inputSchema) {
      async main(input: string): Promise<string> {
        return await this.agent.prose`script override ${input}`;
      }
    }

    const harnesses = openHarnessRegistry("pi", false);

    if (harnesses === undefined) {
      throw new Error("expected known CLI harnesses to open");
    }
    await expect(
      runProgram(ScriptOverrideHarness, "Ada", {
        harnesses,
        defaultHarness: "pi",
        model: "fake",
      }),
    ).resolves.toContain("fake reply for: script override Ada");
  });

  it("fails loudly when neither the script nor CLI selects a harness", async () => {
    class NoSelectedHarness extends Program(inputSchema) {
      async main(input: string): Promise<string> {
        return await this.agent.prose`no selected harness ${input}`;
      }
    }

    const harnesses = openHarnessRegistry(undefined, false);

    if (harnesses === undefined) {
      throw new Error("expected known CLI harnesses to open");
    }
    let caught: unknown;
    try {
      await runProgram(NoSelectedHarness, "Ada", { harnesses, model: "fake" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FoomConfigError);
    expect(caught).toMatchObject({ message: expect.stringContaining("no harness selected") });
  });

  it("rejects an unknown CLI-selected harness before running", () => {
    expect(openHarnessRegistry("missing", false)).toBeUndefined();
  });
});
