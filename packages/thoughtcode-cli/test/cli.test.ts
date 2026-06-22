import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SCRATCH_DIR = "/tmp/agentic_coding";

async function writeProgram(contents: string): Promise<string> {
  const dir = await mkdtemp(join(SCRATCH_DIR, "tc-cli-"));
  const file = join(dir, "program.txt");
  await writeFile(file, contents);
  return file;
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("thoughtcode check", () => {
  it("exits 0 silently for a valid program", async () => {
    const file = await writeProgram("VIBEFUNCTION main()\n    VIBERETURN(1)\n");
    const result = await cli(["check", file]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("reports syntax errors and exits 1", async () => {
    const file = await writeProgram("@bogus(1)\nVIBEFUNCTION fac(n: intfaketype) -> notatype\n    VIBERETURN(n)\n");
    const result = await cli(["check", file]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("unrecognized return type `notatype`");
    expect(result.stdout).toContain("Unknown decorator @bogus");
    expect(result.stdout).toContain("parameter `n` declares an unrecognized type `intfaketype`");
  });

  it("exits 2 for an unreadable file", async () => {
    const result = await cli(["check", "/no/such/file.txt"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read");
  });

  it("exits 2 when no files are given", async () => {
    expect((await cli(["check"])).code).toBe(2);
  });

  it("exits 2 for an unknown command", async () => {
    expect((await cli(["frobnicate"])).code).toBe(2);
  });

  it("prints usage on --help and exits 0", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("thoughtcode check");
  });
});
