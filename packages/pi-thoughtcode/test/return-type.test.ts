import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractReturnType } from "thoughtcode-core";
import { describe, expect, it } from "vitest";
import { checkReturnValue, createVibeReturnTool, isParsableReturnType, resolveReturnType, validateProgramSyntax } from "../dist/index.js";

const SCRATCH_DIR = "/tmp/agentic_coding";

async function writeProgram(contents: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(SCRATCH_DIR, "thoughtcode-rt-"));
  const file = join(dir, "program.txt");
  await writeFile(file, contents);
  return { dir, file };
}

const TYPED_PROGRAM = [
  "# program",
  "VIBEFUNCTION main()",
  "    res = VIBECALL fac(n = 2)",
  "    VIBERETURN(res)",
  "",
  "VIBEFUNCTION fac(n: number) -> number.integer",
  "    VIBERETURN(hello)",
  "",
  "VIBEFUNCTION bogus() -> intfaketype",
  "    VIBERETURN(x)",
].join("\n");

describe("resolveReturnType (file → extract → validate wiring)", () => {
  it("resolves a valid annotation from the program file", async () => {
    const { file } = await writeProgram(TYPED_PROGRAM);
    expect(await resolveReturnType(file, "fac", undefined)).toEqual({ status: "ok", type: "number.integer" });
  });

  it("reports an unrecognized annotation as invalid (the intfaketype bug)", async () => {
    const { file } = await writeProgram(TYPED_PROGRAM);
    expect(await resolveReturnType(file, "bogus", undefined)).toEqual({ status: "invalid", annotation: "intfaketype" });
  });

  it("reports none when the function has no annotation", async () => {
    const { file } = await writeProgram(TYPED_PROGRAM);
    expect(await resolveReturnType(file, "main", undefined)).toEqual({ status: "none" });
  });

  it("resolves a relative path against cwd", async () => {
    const { dir } = await writeProgram(TYPED_PROGRAM);
    expect(await resolveReturnType("program.txt", "fac", dir)).toEqual({ status: "ok", type: "number.integer" });
  });

  it("reports unreadable when the file is missing", async () => {
    expect(await resolveReturnType("/no/such/program.txt", "fac", undefined)).toEqual({ status: "unreadable" });
  });

  it("reports not-found when the function is not declared", async () => {
    const { file } = await writeProgram(TYPED_PROGRAM);
    expect(await resolveReturnType(file, "nope", undefined)).toEqual({ status: "not-found" });
  });

  it("distinguishes a declared-but-untyped function from an absent one", async () => {
    const { file } = await writeProgram(TYPED_PROGRAM);
    expect(await resolveReturnType(file, "main", undefined)).toEqual({ status: "none" });
    expect(await resolveReturnType(file, "main2", undefined)).toEqual({ status: "not-found" });
  });
});

describe("return types rely purely on ArkType (no synonyms)", () => {
  it("accepts native ArkType keywords", () => {
    expect(isParsableReturnType("number.integer")).toBe(true);
    expect(isParsableReturnType("string")).toBe(true);
    expect(isParsableReturnType("boolean")).toBe(true);
  });

  it("rejects friendly aliases that are no longer mapped", () => {
    expect(isParsableReturnType("int")).toBe(false);
    expect(isParsableReturnType("str")).toBe(false);
    expect(isParsableReturnType("bool")).toBe(false);
    expect(isParsableReturnType("@@@ not a type")).toBe(false);
  });

  it("does not coerce aliases at check time", () => {
    // `int` is not an ArkType keyword, so it is treated as no constraint, not as number.integer.
    expect(checkReturnValue("2.5", "int")).toEqual({ ok: true });
    expect(checkReturnValue("2.5", "number.integer").ok).toBe(false);
  });
});

describe("validateProgramSyntax", () => {
  it("passes a program whose declared return types are all valid", () => {
    const program = [
      "VIBEFUNCTION main()",
      "VIBEFUNCTION fac(n: number) -> number.integer",
      'VIBEFUNCTION shape(x) -> { "result": "number" }',
    ].join("\n");
    expect(validateProgramSyntax(program)).toEqual({ ok: true });
  });

  it("flags each unrecognized return type", () => {
    const program = ["VIBEFUNCTION a() -> intfaketype", "VIBEFUNCTION b() -> number", "VIBEFUNCTION c() -> bool"].join("\n");
    const result = validateProgramSyntax(program);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain("`a`");
      expect(result.errors[1]).toContain("`c`");
    }
  });

  it("allows functions with no return type", () => {
    expect(validateProgramSyntax("VIBEFUNCTION main()\nVIBEFUNCTION helper(x)")).toEqual({ ok: true });
  });
});

describe("extractReturnType", () => {
  const program = [
    "# program",
    "VIBEFUNCTION main()",
    "VIBEFUNCTION fac(n: number) -> number.integer",
    'VIBEFUNCTION shape(x) -> { "result": "number", "data": "string" }',
  ].join("\n");

  it("extracts a scalar annotation", () => {
    expect(extractReturnType(program, "fac")).toBe("number.integer");
  });

  it("extracts a structural (JSON) annotation", () => {
    expect(extractReturnType(program, "shape")).toBe('{ "result": "number", "data": "string" }');
  });

  it("returns undefined when the function has no annotation", () => {
    expect(extractReturnType(program, "main")).toBeUndefined();
  });

  it("returns undefined when the function is absent", () => {
    expect(extractReturnType(program, "missing")).toBeUndefined();
  });
});

describe("checkReturnValue", () => {
  it("accepts a matching integer", () => {
    expect(checkReturnValue("2", "number.integer")).toEqual({ ok: true });
  });

  it("rejects a non-integer", () => {
    const result = checkReturnValue("2.5", "number.integer");
    expect(result.ok).toBe(false);
  });

  it("rejects prose for a numeric type", () => {
    const result = checkReturnValue("The answer is 2", "number.integer");
    expect(result.ok).toBe(false);
  });

  it("accepts a matching union literal", () => {
    expect(checkReturnValue("ok", '"ok" | "fail"')).toEqual({ ok: true });
  });

  it("validates structural JSON returns", () => {
    expect(checkReturnValue('{"result":2,"data":"x"}', '{ "result": "number", "data": "string" }')).toEqual({ ok: true });
    expect(checkReturnValue('{"result":"two","data":"x"}', '{ "result": "number", "data": "string" }').ok).toBe(false);
  });

  it("treats a malformed annotation as no constraint", () => {
    expect(checkReturnValue("anything", "@@@ not a type @@@")).toEqual({ ok: true });
  });
});

describe("createVibeReturnTool type enforcement", () => {
  it("accepts a correctly typed value immediately", async () => {
    let returned: string | undefined;
    const tool = createVibeReturnTool({ returnType: "number.integer", onVibeReturn: (v) => (returned = v) });
    const result = await tool.execute("c1", { value: "2" });
    expect(returned).toBe("2");
    expect(result.details).toEqual({ kind: "vibereturn", value: "2" });
  });

  it("throws on a type mismatch so the agent retries", async () => {
    const tool = createVibeReturnTool({ returnType: "number.integer", onVibeReturn: () => {} });
    await expect(tool.execute("c1", { value: "not a number" })).rejects.toThrow(/declared return type/);
  });

  it("stops rejecting after the failure cap to avoid an infinite loop", async () => {
    let returned: string | undefined;
    const tool = createVibeReturnTool({ returnType: "number.integer", onVibeReturn: (v) => (returned = v) });
    // 3 rejected attempts (the cap), then the 4th is accepted despite being wrong.
    for (let i = 0; i < 3; i += 1) {
      await expect(tool.execute("c1", { value: "bad" })).rejects.toThrow();
    }
    const result = await tool.execute("c1", { value: "bad" });
    expect(returned).toBe("bad");
    expect(result.details).toEqual({ kind: "vibereturn", value: "bad" });
  });

  it("skips checking entirely when no return type is declared", async () => {
    let returned: string | undefined;
    const tool = createVibeReturnTool({ onVibeReturn: (v) => (returned = v) });
    await tool.execute("c1", { value: "anything goes" });
    expect(returned).toBe("anything goes");
  });
});
