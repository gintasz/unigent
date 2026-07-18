import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@unigent/core";
import { describe, expect, it } from "vitest";
import { parseTraceRecord } from "../src/protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const fixture = resolve(here, "support/traced_script.ts");
const bunFixture = resolve(here, "support/bun_script.ts");
const nodeTypescriptFixture = resolve(here, "support/node_typescript_script.ts");
const throwingFixture = resolve(here, "support/throwing_script.ts");
const throwingWithHandleFixture = resolve(here, "support/throwing_with_handle.ts");
const signalFixture = resolve(here, "support/signal_script.ts");
const interactiveFixture = resolve(here, "support/interactive_script.ts");
const register = resolve(packageRoot, "dist/register.js");
const cli = resolve(packageRoot, "dist/cli.js");
const developmentCli = resolve(packageRoot, "../../scripts/unigent-dev.mjs");

function readStream(stream: Readable): Promise<string> {
  return new Promise<string>((resolveText, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      text += chunk;
    });
    stream.once("end", () => resolveText(text));
    stream.once("error", reject);
  });
}

describe("Unigent CLI process integration", () => {
  it("exposes the source CLI through the development binary", async () => {
    const child = spawn(process.execPath, [developmentCli, "--help"], {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    const stdout = child.stdout === null ? "" : await readStream(child.stdout);
    const exitCode = await exit;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("unigent — run and inspect a Unigent script");
  });

  it("prints the package version", async () => {
    const child = spawn(process.execPath, [cli, "--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    const stdout = child.stdout === null ? "" : await readStream(child.stdout);
    const exitCode = await exit;

    expect(exitCode).toBe(0);
    expect(stdout).toBe("0.1.8\n");
  });

  it("reports a missing script without a raw ENOENT", async () => {
    const missing = resolve(tmpdir(), "unigent-missing-script.ts");
    const child = spawn(process.execPath, [cli, missing], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    const stderr = child.stderr === null ? "" : await readStream(child.stderr);
    const exitCode = await exit;

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`unigent: script file not found: ${missing}`);
    expect(stderr).not.toContain("ENOENT");
  });

  it("does not prompt when required input is missing without -i", async () => {
    const child = spawn(process.execPath, [cli, interactiveFixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    const stderr = child.stderr === null ? "" : await readStream(child.stderr);
    const exitCode = await exit;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("unigent:");
    expect(stderr).not.toContain("Topic to research:");
  });

  it("rejects -i immediately when no interactive terminal is attached", async () => {
    const child = spawn(process.execPath, [cli, interactiveFixture, "-i"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    const stderr = child.stderr === null ? "" : await readStream(child.stderr);
    const exitCode = await exit;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("-i requires an interactive terminal");
    expect(stderr).toContain("unavailable in TUI and piped execution");
  });

  it("runs a TypeScript file directly and preserves its arguments and stdout", async () => {
    const child = spawn(process.execPath, [cli, fixture, "Ada"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    const stdout = child.stdout === null ? "" : await readStream(child.stdout);
    const exitCode = await exit;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("SCRIPT OUTPUT: Hello, Ada.");
  });

  it("resolves a NodeNext TypeScript module graph without a Bun shebang", async () => {
    const child = spawn(process.execPath, [cli, nodeTypescriptFixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    const stdout = child.stdout === null ? "" : await readStream(child.stdout);
    const exitCode = await exit;

    expect(exitCode).toBe(0);
    expect(stdout).toBe("TYPESCRIPT MODULE: loaded\nSCRIPT RUNTIME: node\n");
  });

  it("honors a Bun shebang in direct mode", async () => {
    const child = spawn(process.execPath, [cli, bunFixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    const stdout = child.stdout === null ? "" : await readStream(child.stdout);
    const exitCode = await exit;

    expect(exitCode).toBe(0);
    expect(stdout).toBe("SCRIPT RUNTIME: bun\n");
  });

  it("prints uncaught script errors with an actionable runtime stack", async () => {
    const child = spawn(process.execPath, [cli, throwingFixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    const stderr = child.stderr === null ? "" : await readStream(child.stderr);
    const exitCode = await exit;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("unigent: Error: STARTUP FAILURE: invalid script input");
    expect(stderr).toContain("throwing_script.ts:1:7");
    expect(stderr).not.toContain("Node.js v");
  });

  it("exits after a fatal error even when the script has a live handle", async () => {
    const child = spawn(process.execPath, [cli, throwingWithHandleFixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = child.stderr === null ? "" : await readStream(child.stderr);
    const exitCode = await new Promise<number | null>((resolveCode) =>
      child.once("exit", resolveCode),
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("FATAL WITH LIVE HANDLE");
    expect(stderr).toContain("throwing_with_handle.ts:2:7");
  });

  it("forwards SIGINT to the running script and returns exit code 130", async () => {
    const child = spawn(process.execPath, [cli, fixture, "__slow__"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolveReady, reject) => {
      child.stdout?.once("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("SCRIPT READY")) {
          resolveReady();
        } else {
          reject(new Error("script did not emit its readiness marker"));
        }
      });
      child.once("error", reject);
    });
    const exit = new Promise<number | null>((resolveCode) => child.once("exit", resolveCode));
    child.kill("SIGINT");

    const exitCode = await exit;

    expect(exitCode).toBe(130);
  });

  it("maps a child signal to the conventional shell exit code", async () => {
    const child = spawn(process.execPath, [cli, signalFixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const exitCode = await new Promise<number | null>((resolveCode) =>
      child.once("exit", resolveCode),
    );

    expect(exitCode).toBe(143);
  });

  it("does not serialize traces without an explicit trace transport", async () => {
    const child = spawn(process.execPath, ["--import", register, fixture, "NoTrace"], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const [, , , traceStream] = child.stdio;
    if (!(traceStream instanceof Readable)) {
      throw new Error("trace stream was not created");
    }

    const [traceText, exitCode] = await Promise.all([
      readStream(traceStream),
      new Promise<number | null>((resolveCode) => child.once("exit", resolveCode)),
    ]);

    expect(exitCode).toBe(0);
    expect(traceText).toBe("");
  });

  it("streams traces over fd 3 without contaminating stdout", async () => {
    const child = spawn(process.execPath, ["--import", register, fixture, "Lin"], {
      env: { ...process.env, UNIGENT_TRACE_FILE_DESCRIPTOR: "3" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const [, stdoutStream, stderrStream, traceStream] = child.stdio;
    if (
      !(stdoutStream instanceof Readable) ||
      !(stderrStream instanceof Readable) ||
      !(traceStream instanceof Readable)
    ) {
      throw new Error("child streams were not created");
    }
    const [stdout, stderr, traceText, exitCode] = await Promise.all([
      readStream(stdoutStream),
      readStream(stderrStream),
      readStream(traceStream),
      new Promise<number | null>((resolveCode) => child.once("exit", resolveCode)),
    ]);
    const events: AgentEvent[] = traceText
      .trim()
      .split("\n")
      .flatMap((line) => {
        const record = parseTraceRecord(line);
        return record === undefined ? [] : [record.event];
      });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("SCRIPT OUTPUT: Hello, Lin.\n");
    expect(stdout).not.toContain("traceId");
    expect(events.map((event) => event.type)).toEqual([
      "span_start",
      "system_prompt",
      "user_prompt",
      "span_start",
      "reasoning",
      "text",
      "span_end",
      "span_end",
    ]);
    expect(
      events.filter((event) => event.type === "span_start").map((event) => event.kind),
    ).toEqual(["run", "turn"]);
    expect(events.at(-1)).toMatchObject({ outcome: "succeeded", usage: { totalTokens: 18 } });
  });

  it("turns SIGINT into a graceful Unigent cancellation before the process exits", async () => {
    const child = spawn(process.execPath, ["--import", register, fixture, "__slow__"], {
      env: { ...process.env, UNIGENT_TRACE_FILE_DESCRIPTOR: "3" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const [, , , traceStream] = child.stdio;
    if (!(traceStream instanceof Readable)) {
      throw new Error("trace stream was not created");
    }
    let interrupted = false;
    traceStream.on("data", (chunk: Buffer) => {
      if (!interrupted && chunk.toString("utf8").includes('"type":"user_prompt"')) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    const exit = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    const traceText = await readStream(traceStream);
    const exitCode = await exit;
    const events = traceText
      .trim()
      .split("\n")
      .flatMap((line) => {
        const record = parseTraceRecord(line);
        return record === undefined ? [] : [record.event];
      });

    expect(interrupted).toBe(true);
    expect(exitCode).toBe(130);
    expect(events.at(-1)).toMatchObject({ type: "span_end", outcome: "cancelled" });
  });
});
