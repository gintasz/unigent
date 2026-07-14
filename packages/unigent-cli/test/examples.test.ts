import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "../../..");
const developmentCli = resolve(workspaceRoot, "scripts/unigent-dev.mjs");
const examples = ["hello.ts", "pitch.ts", "skill_improvement.ts", "standalone.ts"] as const;

describe("published examples", () => {
  it.each(examples)("starts %s through the CLI without contacting a model", async (example) => {
    const source = resolve(workspaceRoot, "examples", example);
    const { stderr, stdout } = await execute(process.execPath, [developmentCli, source, "--help"]);

    expect(stderr).toBe("");
    expect(stdout).toContain(`Usage: ${example}`);
  });

  it("starts the standalone example directly through its Bun shebang", async () => {
    const source = resolve(workspaceRoot, "examples/standalone.ts");
    const { stderr, stdout } = await execute("bun", [source, "--help"]);

    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: standalone.ts");
  });
});
