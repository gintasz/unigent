import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { AgentConfigError, resolveWorkdir, spawnAdapterProcess } from "@unigent/core";
import { describe, expect, it } from "vitest";

describe("adapter working directories", () => {
  it("resolves relative directories once and launches subprocesses inside them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unigent-workdir-"));
    try {
      const resolved = resolveWorkdir(relative(process.cwd(), directory));
      const child = spawnAdapterProcess({
        binary: process.execPath,
        args: ["-e", "process.stdout.write(process.cwd())"],
        signal: new AbortController().signal,
        stdin: "",
        environment: {},
        workdir: resolved,
      });
      const lines: string[] = [];
      for await (const line of child.lines) {
        lines.push(line);
      }
      await child.completion;

      expect(resolved).toBe(realpathSync(directory));
      expect(lines).toEqual([realpathSync(directory)]);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("rejects empty, missing, and non-directory workdirs", () => {
    const directory = mkdtempSync(join(tmpdir(), "unigent-workdir-invalid-"));
    const file = join(directory, "file.txt");
    writeFileSync(file, "not a directory");
    try {
      expect(() => resolveWorkdir(" ")).toThrow(AgentConfigError);
      expect(() => resolveWorkdir(join(directory, "missing"))).toThrow(AgentConfigError);
      expect(() => resolveWorkdir(file)).toThrow(AgentConfigError);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
