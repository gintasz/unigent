import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  detectScriptRuntime,
  runtimeInvocation,
  type ScriptRuntime,
} from "../src/script_runtime.ts";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "unigent-script-runtime-"));

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("script runtime selection", () => {
  it.each([
    { source: "#!/usr/bin/env bun\n", expected: "bun" },
    { source: "#!/usr/bin/env -S bun --smol\n", expected: "bun" },
    { source: "#!/opt/homebrew/bin/bun\n", expected: "bun" },
    { source: "#!/usr/bin/env node\n", expected: "node" },
    { source: "console.log('plain TypeScript');\n", expected: "node" },
  ] satisfies ReadonlyArray<{
    source: string;
    expected: ScriptRuntime;
  }>)("detects $expected from $source", async ({ source, expected }) => {
    const sourceFile = join(temporaryDirectory, `${randomUUID()}.ts`);
    writeFileSync(sourceFile, source);

    await expect(detectScriptRuntime(sourceFile)).resolves.toBe(expected);
  });

  it("enables Bun fallback installation for package-free scripts", () => {
    expect(runtimeInvocation("bun", "/path/to/node")).toEqual({
      kind: "bun",
      executable: "bun",
      arguments: ["--install=fallback"],
    });
    expect(runtimeInvocation("node", "/path/to/node")).toEqual({
      kind: "node",
      executable: "/path/to/node",
      arguments: [],
    });
  });

  it("reports a missing script without exposing a raw filesystem error", async () => {
    const sourceFile = join(temporaryDirectory, "missing.ts");

    await expect(detectScriptRuntime(sourceFile)).rejects.toThrow(
      `script file not found: ${sourceFile}`,
    );
  });
});
