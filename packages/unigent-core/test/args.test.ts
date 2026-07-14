import process from "node:process";
import { AgentInputError } from "@unigent/core";
import { args, parseArgs } from "@unigent/core/args";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const DEFAULT_VALIDATION_MESSAGE = /^unigent: .+\n\nUsage: task\.ts "Prompt"\n$/u;

describe("typed script arguments", () => {
  const originalArguments = process.argv;

  afterEach(() => {
    process.argv = originalArguments;
    vi.restoreAllMocks();
  });

  it("assembles dotted, repeated, boolean, negated, inline, and coerced flags", async () => {
    const parsed = await parseArgs(
      [
        "--user.name",
        "Ada",
        "--tag",
        "one",
        "--tag=two",
        "--count",
        "5",
        "--verbose",
        "--no-cache",
      ],
      z.object({
        user: z.object({ name: z.string() }),
        tag: z.array(z.string()),
        count: z.number(),
        verbose: z.boolean(),
        cache: z.boolean(),
      }),
    );

    expect(parsed).toEqual({
      user: { name: "Ada" },
      tag: ["one", "two"],
      count: 5,
      verbose: true,
      cache: false,
    });
  });

  it("uses the schema to undo ambiguous scalar coercion", async () => {
    const parsed = await parseArgs(
      ["--path", "5", "--codes", "1", "--codes", "2"],
      z.object({ path: z.string(), codes: z.array(z.string()) }),
    );

    expect(parsed).toEqual({ path: "5", codes: ["1", "2"] });
  });

  it("returns transformed schema output", async () => {
    const parsed = await parseArgs(
      ["--name", " unigent "],
      z.object({ name: z.string().transform((value) => value.trim().toUpperCase()) }),
    );

    expect(parsed).toEqual({ name: "UNIGENT" });
  });

  it("treats a scalar schema as natural positional input", async () => {
    await expect(parseArgs(["Kebab", "app"], z.string())).resolves.toBe("Kebab app");
    await expect(parseArgs(["--", "Kebab", "app"], z.string())).resolves.toBe("Kebab app");
    await expect(parseArgs(["5"], z.number())).resolves.toBe(5);
    await expect(parseArgs(["5"], z.string())).resolves.toBe("5");
    await expect(parseArgs([], z.string().min(1))).rejects.toThrow("Too small");
  });

  it("rejects invalid, positional, conflicting, and unsafe inputs", async () => {
    await expect(parseArgs(["--count", "word"], z.object({ count: z.number() }))).rejects.toThrow(
      AgentInputError,
    );
    await expect(parseArgs(["positional"])).rejects.toThrow("unexpected positional argument");
    await expect(parseArgs(["positional", "--count", "2"], z.string())).rejects.toThrow(
      "cannot mix positional input with named argument",
    );
    await expect(parseArgs(["--a", "1", "--a.b", "2"])).rejects.toThrow("argument path conflicts");
    await expect(parseArgs(["--__proto__.polluted", "yes"])).rejects.toThrow(
      "unsafe or empty argument path",
    );
  });

  it.each(["--help", "-h"])("prints standardized help for %s", async (helpFlag) => {
    process.argv = ["node", "/work/task.ts", helpFlag];
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = new Error("exit");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw exit;
    });

    await expect(
      args(z.string(), { description: "Describe a task.", usage: '"Prompt"' }),
    ).rejects.toBe(exit);
    expect(output).toHaveBeenCalledWith('Describe a task.\n\nUsage: task.ts "Prompt"\n');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("prints schema validation errors without requiring authored messages", async () => {
    process.argv = ["node", "/work/task.ts"];
    const output = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = new Error("exit");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw exit;
    });

    await expect(args(z.string().min(1), { usage: '"Prompt"' })).rejects.toBe(exit);
    expect(output).toHaveBeenCalledWith(expect.stringMatching(DEFAULT_VALIDATION_MESSAGE));
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
