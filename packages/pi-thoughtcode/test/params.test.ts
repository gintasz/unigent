import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseProgram, parseVibeCallArgs, parseVibeFunctionParams, serializeVibeCallArgs } from "thoughtcode-core";
import { describe, expect, it } from "vitest";
import { bindAndCheckArgs, collectVibeFunctionErrors, createThoughtcodeTools, prepareEntrypoint } from "../dist/index.js";

const SCRATCH_DIR = "/tmp/agentic_coding";

async function writeProgram(contents: string): Promise<string> {
  const cwd = await mkdtemp(join(SCRATCH_DIR, "thoughtcode-params-"));
  await writeFile(join(cwd, "program.txt"), contents);
  return cwd;
}

describe("parseVibeFunctionParams", () => {
  it("parses typed params, defaults, and untyped params", () => {
    const prog = ['VIBEFUNCTION f(a: number, b: string = "hi", c) -> number', "    VIBERETURN(a)"].join("\n");
    expect(parseVibeFunctionParams(prog, "f")).toEqual({
      params: [
        { name: "a", type: "number", hasDefault: false },
        { name: "b", type: "string", default: "hi", hasDefault: true },
        { name: "c", type: undefined, hasDefault: false },
      ],
      errors: [],
    });
  });

  it("handles a no-arg function", () => {
    expect(parseVibeFunctionParams("VIBEFUNCTION main()", "main")).toEqual({ params: [], errors: [] });
  });

  it("does not split on commas/colons inside a structural type", () => {
    const prog = 'VIBEFUNCTION f(shape: { "a": "number", "b": "string" }, n: number)';
    const result = parseVibeFunctionParams(prog, "f");
    expect(result.errors).toEqual([]);
    expect(result.params.map((p) => p.name)).toEqual(["shape", "n"]);
    expect(result.params[0].type).toBe('{ "a": "number", "b": "string" }');
  });

  it("reports an invalid default", () => {
    const result = parseVibeFunctionParams("VIBEFUNCTION f(a: number = nope)", "f");
    expect(result.errors[0]).toMatch(/default must be a JSON literal/);
  });
});

describe("parseVibeCallArgs / serializeVibeCallArgs", () => {
  it("parses named JSON-literal values", () => {
    expect(parseVibeCallArgs('a=1, b="two", c=true')).toEqual({
      values: { a: 1, b: "two", c: true },
      errors: [],
    });
  });

  it("rejects positional and malformed args", () => {
    expect(parseVibeCallArgs("5").errors[0]).toMatch(/named arguments only/);
    expect(parseVibeCallArgs("a=nope").errors[0]).toMatch(/JSON literal/);
  });

  it("round-trips through serialize", () => {
    expect(serializeVibeCallArgs({ a: 1, b: "two" })).toBe('a=1, b="two"');
  });
});

describe("collectVibeFunctionErrors (param declarations)", () => {
  it("accepts valid param types", () => {
    const fn = parseProgram('VIBEFUNCTION f(a: number, b: string = "x")\n    VIBERETURN(a)').functions.get("f");
    if (!fn) throw new Error("missing f");
    expect(collectVibeFunctionErrors(fn)).toEqual([]);
  });

  it("flags an unrecognized param type", () => {
    const fn = parseProgram("VIBEFUNCTION f(a: intfaketype)\n    VIBERETURN(a)").functions.get("f");
    if (!fn) throw new Error("missing f");
    expect(collectVibeFunctionErrors(fn).some((error) => error.includes("intfaketype"))).toBe(true);
  });
});

describe("bindAndCheckArgs", () => {
  const params = [
    { name: "a", type: "number", hasDefault: false },
    { name: "b", type: "string", default: "x", hasDefault: true },
    { name: "c", type: undefined, hasDefault: false },
  ];

  it("binds, applies defaults, and type-checks", () => {
    expect(bindAndCheckArgs(params, { a: 2, c: true })).toEqual({ ok: true, bound: { a: 2, b: "x", c: true } });
  });

  it("rejects a missing required argument", () => {
    const result = bindAndCheckArgs(params, { a: 2 });
    expect(result).toEqual({ ok: false, error: "missing required argument `c`" });
  });

  it("rejects an unknown argument", () => {
    expect(bindAndCheckArgs(params, { a: 2, c: 1, z: 9 })).toEqual({ ok: false, error: "unknown argument `z`" });
  });

  it("rejects a wrong-typed argument", () => {
    const result = bindAndCheckArgs(params, { a: "nope", c: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/argument `a` must be `number`/);
  });

  it("skips type checking for untyped params", () => {
    expect(bindAndCheckArgs(params, { a: 1, c: { anything: true } })).toEqual({
      ok: true,
      bound: { a: 1, b: "x", c: { anything: true } },
    });
  });
});

describe("VIBECALL argument enforcement (integration)", () => {
  async function run(programBody: string, args: string, opts: { onCall?: (callArgs: string) => void } = {}) {
    const cwd = await writeProgram(programBody);
    let called = false;
    const [vibeCall] = createThoughtcodeTools({
      async runSubagent(request) {
        called = true;
        opts.onCall?.(request.call.args);
        return "ok";
      },
    });
    const result = await vibeCall.execute(
      "call-1",
      { program_file_path: "./program.txt", name: "f", args },
      undefined,
      undefined,
      { cwd } as never,
    );
    return { result, called };
  }

  it("applies defaults and injects resolved args into the call", async () => {
    let injected: string | undefined;
    const { result, called } = await run("VIBEFUNCTION f(x: number, y: number = 10)\n    VIBERETURN(x)", "x=1", {
      onCall: (a) => (injected = a),
    });
    expect(called).toBe(true);
    expect(injected).toBe("x=1, y=10");
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("rejects a wrong-typed argument without spawning the subagent", async () => {
    const { result, called } = await run('VIBEFUNCTION f(x: number)\n    VIBERETURN(x)', 'x="hello"');
    expect(called).toBe(false);
    expect(result.details.status).toBe("error");
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("argument `x` must be `number`") });
  });

  it("rejects a missing required argument", async () => {
    const { result, called } = await run("VIBEFUNCTION f(x: number)\n    VIBERETURN(x)", "");
    expect(called).toBe(false);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("missing required argument `x`") });
  });

  it("rejects an unknown argument", async () => {
    const { result, called } = await run("VIBEFUNCTION f(x: number)\n    VIBERETURN(x)", "x=1, z=2");
    expect(called).toBe(false);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("unknown argument `z`") });
  });
});

describe("prepareEntrypoint (/thoughtcode-run arg forms)", () => {
  async function prep(programBody: string, func: string, rawArgs: string) {
    const cwd = await writeProgram(programBody);
    return prepareEntrypoint("./program.txt", func, rawArgs, cwd);
  }

  const ONE = "VIBEFUNCTION fac(n: number.integer)\n    VIBERETURN(n)";
  const STR = "VIBEFUNCTION greet(name: string)\n    VIBERETURN(name)";
  const MULTI = 'VIBEFUNCTION sum(a: number, b: number = 10)\n    VIBERETURN(a)';

  it("binds a bare numeric value to the sole param", async () => {
    expect(await prep(ONE, "fac", "5")).toEqual({ ok: true, args: "n=5" });
  });

  it("treats a bare non-JSON token as a string for a string param", async () => {
    expect(await prep(STR, "greet", "world")).toEqual({ ok: true, args: 'name="world"' });
  });

  it("accepts a JSON object for multiple params and applies defaults", async () => {
    expect(await prep(MULTI, "sum", '{"a": 3}')).toEqual({ ok: true, args: "a=3, b=10" });
  });

  it("accepts name=value pairs", async () => {
    expect(await prep(MULTI, "sum", "a=3, b=4")).toEqual({ ok: true, args: "a=3, b=4" });
  });

  it("accepts an empty arg string for a no-arg function", async () => {
    expect(await prep("VIBEFUNCTION main()\n    VIBERETURN(1)", "main", "")).toEqual({ ok: true, args: "" });
  });

  it("rejects a bare value when the function has multiple params", async () => {
    const result = await prep(MULTI, "sum", "3");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/takes 2 arguments/);
  });

  it("rejects extra input for a no-arg function with a clear message", async () => {
    const result = await prep("VIBEFUNCTION main()\n    VIBERETURN(1)", "main", "5");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("`main` takes no arguments");
  });

  it("rejects a wrong-typed bare value", async () => {
    const result = await prep(ONE, "fac", '"hello"');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/argument `n` must be/);
  });

  it("rejects an unknown entrypoint", async () => {
    const result = await prep(ONE, "nope", "1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not defined/);
  });

  it("reports an unreadable program", async () => {
    const result = await prepareEntrypoint("/no/such.txt", "fac", "1", undefined);
    expect(result).toEqual({ ok: false, error: "Cannot read program /no/such.txt" });
  });
});
