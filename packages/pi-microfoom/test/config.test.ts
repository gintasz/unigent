import { FoomtimeConfigError } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

describe("microfoom config", () => {
  it("defaults a program name to its filename stem (audit.ts → audit)", () => {
    const config = parseConfig(
      { programs: [{ disable_model_invocation: true, path: "progs/audit.ts" }] },
      "/cfg",
    );
    const [program] = config.programs;
    expect(program?.name).toBe("audit");
    expect(program?.sourceFile).toBe("/cfg/progs/audit.ts");
    if (program?.type === "command") expect(program.description).toBe("(microfoom) progs/audit.ts");
  });

  it("resolves model default + per-entry override", () => {
    const config = parseConfig(
      {
        model: "root-model",
        programs: [{ disable_model_invocation: true, path: "a.ts", model: "entry-model" }],
      },
      "/cfg",
    );
    expect(config.defaultModel).toBe("root-model");
    expect(config.programs[0]?.model).toBe("entry-model");
  });

  it("maps disable_model_invocation true → command, false → tool", () => {
    const config = parseConfig(
      {
        programs: [
          { disable_model_invocation: true, path: "a.ts" },
          { disable_model_invocation: false, path: "b.ts", description: "does b" },
        ],
      },
      "/cfg",
    );
    expect(config.programs[0]?.type).toBe("command");
    expect(config.programs[1]?.type).toBe("tool");
  });

  it("requires disable_model_invocation to be a boolean (no implicit default)", () => {
    expect(() => parseConfig({ programs: [{ path: "a.ts" }] }, "/cfg")).toThrow(
      FoomtimeConfigError,
    );
  });

  it("requires a description on a tool entry", () => {
    expect(() =>
      parseConfig({ programs: [{ disable_model_invocation: false, path: "a.ts" }] }, "/cfg"),
    ).toThrow(FoomtimeConfigError);
  });

  it("rejects duplicate names within a namespace", () => {
    expect(() =>
      parseConfig(
        {
          programs: [
            { disable_model_invocation: true, path: "a.ts", name: "x" },
            { disable_model_invocation: true, path: "b.ts", name: "x" },
          ],
        },
        "/cfg",
      ),
    ).toThrow(/duplicate command name/);
  });

  it("allows a command and a tool to share a name (the both-pattern)", () => {
    const config = parseConfig(
      {
        programs: [
          { disable_model_invocation: true, path: "a.ts", name: "x" },
          { disable_model_invocation: false, path: "a.ts", name: "x", description: "does x" },
        ],
      },
      "/cfg",
    );
    expect(config.programs).toHaveLength(2);
  });
});
