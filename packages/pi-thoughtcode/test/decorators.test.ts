import { listVibeFunctionNames, parseDecoratorsForFunction, parseProgram } from "thoughtcode-core";
import { describe, expect, it } from "vitest";
import { buildVibeRunConfig, validateProgramSyntax } from "../dist/index.js";

const PROGRAM = [
  '@model("claude-opus-4-8")',
  "@timeout(30)",
  "VIBEFUNCTION fac(n: number) -> number.integer",
  "    VIBERETURN(1)",
  "",
  "@budget(0.5)",
  "",
  "VIBEFUNCTION main()",
  "    VIBERETURN(1)",
].join("\n");

describe("parseDecoratorsForFunction", () => {
  it("parses stacked positional decorators directly above a function", () => {
    const { decorators, errors } = parseDecoratorsForFunction(PROGRAM, "fac");
    expect(errors).toEqual([]);
    expect(decorators).toEqual([
      { name: "model", positional: "claude-opus-4-8", kwargs: {} },
      { name: "timeout", positional: 30, kwargs: {} },
    ]);
  });

  it("skips blank lines between a decorator and the declaration", () => {
    const { decorators } = parseDecoratorsForFunction(PROGRAM, "main");
    expect(decorators).toEqual([{ name: "budget", positional: 0.5, kwargs: {} }]);
  });

  it("parses keyword arguments", () => {
    const prog = ["@retry(times=3, backoff=2)", "VIBEFUNCTION f()"].join("\n");
    expect(parseDecoratorsForFunction(prog, "f").decorators).toEqual([
      { name: "retry", kwargs: { times: 3, backoff: 2 } },
    ]);
  });

  it("parses a bare decorator with no parentheses", () => {
    const prog = ["@cache", "VIBEFUNCTION f()"].join("\n");
    expect(parseDecoratorsForFunction(prog, "f").decorators).toEqual([{ name: "cache", kwargs: {} }]);
  });

  it("reports an unquoted string argument as an error", () => {
    const prog = ["@model(opus)", "VIBEFUNCTION f()"].join("\n");
    const { errors } = parseDecoratorsForFunction(prog, "f");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/double-quoted/);
  });

  it("rejects mixing positional and keyword arguments", () => {
    const prog = ["@retry(3, times=2)", "VIBEFUNCTION f()"].join("\n");
    expect(parseDecoratorsForFunction(prog, "f").errors[0]).toMatch(/cannot mix/);
  });

  it("rejects multiple positional arguments", () => {
    const prog = ["@foo(1, 2)", "VIBEFUNCTION f()"].join("\n");
    expect(parseDecoratorsForFunction(prog, "f").errors[0]).toMatch(/one positional/);
  });

  it("ignores @-lines that are not directly above the function", () => {
    const prog = ["@model(\"x\")", "VIBEFUNCTION other()", "    VIBERETURN(1)", "", "VIBEFUNCTION f()"].join("\n");
    expect(parseDecoratorsForFunction(prog, "f").decorators).toEqual([]);
  });
});

describe("listVibeFunctionNames", () => {
  it("lists every declared function in order", () => {
    expect(listVibeFunctionNames(PROGRAM)).toEqual(["fac", "main"]);
  });
});

describe("buildVibeRunConfig", () => {
  it("maps known decorators to a run config", () => {
    const { config, errors } = buildVibeRunConfig([
      { name: "model", positional: "opus", kwargs: {} },
      { name: "timeout", positional: 30, kwargs: {} },
      { name: "budget", positional: 0.5, kwargs: {} },
      { name: "thinking", positional: "high", kwargs: {} },
    ]);
    expect(errors).toEqual([]);
    expect(config).toEqual({ modelId: "opus", timeoutMs: 30000, budgetUsd: 0.5, thinkingLevel: "high" });
  });

  it("flags unknown decorators", () => {
    const { errors } = buildVibeRunConfig([{ name: "wat", kwargs: {} }]);
    expect(errors[0]).toMatch(/Unknown decorator @wat/);
  });

  it("validates argument types", () => {
    expect(buildVibeRunConfig([{ name: "timeout", positional: "soon", kwargs: {} }]).errors[0]).toMatch(/positive number/);
    expect(buildVibeRunConfig([{ name: "thinking", positional: "ultra", kwargs: {} }]).errors[0]).toMatch(/expects one of/);
    expect(buildVibeRunConfig([{ name: "budget", positional: -1, kwargs: {} }]).errors[0]).toMatch(/positive number/);
  });
});

describe("parseProgram body extraction", () => {
  it("captures each function's body, excluding the next function's decorators", () => {
    const program = parseProgram(PROGRAM);
    expect(program.functions.get("fac")?.body).toBe("VIBERETURN(1)");
    expect(program.functions.get("main")?.body).toBe("VIBERETURN(1)");
  });

  it("captures multi-line bodies", () => {
    const prog = ["VIBEFUNCTION f(n: number)", "    step one", "    step two", ""].join("\n");
    expect(parseProgram(prog).functions.get("f")?.body).toBe("step one\n    step two");
  });
});

describe("decorators via the Program model", () => {
  it("builds a run config from a function's decorators", () => {
    const fn = parseProgram(PROGRAM).functions.get("fac");
    if (!fn) throw new Error("missing fac");
    expect(buildVibeRunConfig(fn.decorators)).toEqual({
      config: { modelId: "claude-opus-4-8", timeoutMs: 30000 },
      errors: [],
    });
  });

  it("reports invalid decorator args", () => {
    const prog = ['@timeout("nope")', "VIBEFUNCTION f()", "    VIBERETURN(1)"].join("\n");
    const fn = parseProgram(prog).functions.get("f");
    if (!fn) throw new Error("missing f");
    expect(buildVibeRunConfig(fn.decorators).errors.length).toBeGreaterThan(0);
  });
});

describe("validateProgramSyntax catches decorator errors", () => {
  it("flags an unknown decorator", () => {
    const prog = ["@bogus(1)", "VIBEFUNCTION f()", "    VIBERETURN(1)"].join("\n");
    const result = validateProgramSyntax(prog);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => /@bogus/.test(e))).toBe(true);
  });

  it("passes a program with valid decorators", () => {
    expect(validateProgramSyntax(PROGRAM)).toEqual({ ok: true });
  });
});
