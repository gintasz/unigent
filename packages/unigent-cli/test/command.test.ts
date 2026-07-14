import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/command.ts";

describe("Unigent CLI command contract", () => {
  it.each([
    { label: "without a separator", arguments: ["tui", "task.ts", "--model", "local"] },
    { label: "with a separator", arguments: ["tui", "task.ts", "--", "--model", "local"] },
  ])("keeps script arguments opaque $label", ({ arguments: arguments_ }) => {
    const parsed = parseCommand(arguments_, "/work");

    expect(parsed).toEqual({
      kind: "run",
      command: {
        mode: "tui",
        sourceFile: resolve("/work/task.ts"),
        scriptArguments: ["--model", "local"],
      },
    });
  });

  it("uses run mode when the verb is omitted", () => {
    expect(parseCommand(["task.ts", "Ada"], "/work")).toMatchObject({
      command: { mode: "run", scriptArguments: ["Ada"] },
    });
  });

  it.each(["--version", "-V"])("parses the %s version flag", (flag) => {
    expect(parseCommand([flag], "/work")).toEqual({ kind: "version" });
  });

  it("parses the source-tool bake command", () => {
    expect(parseCommand(["bake", "src/worker.ts"], "/work")).toEqual({
      kind: "bake",
      command: { sourceFile: resolve("/work/src/worker.ts") },
    });
  });
});
