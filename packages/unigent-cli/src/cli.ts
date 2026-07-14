#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as operatingSystemConstants } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { bakeSourceTools } from "@unigent/core";
import packageManifest from "../package.json" with { type: "json" };
import { parseCommand, type RunCommand } from "./command.js";
import { childProcessEnvironment } from "./environment.js";
import { assertSupportedNodeVersion } from "./node_version.js";
import { TRACE_TRANSPORT_ENVIRONMENT_VARIABLE } from "./protocol.js";
import { detectScriptRuntime, runtimeInvocation } from "./script_runtime.js";

const HELP = `unigent — run and inspect a Unigent script

Usage:
  unigent <file> [args...]      run a TypeScript or JavaScript file
  unigent run <file> [args...]  same, explicitly
  unigent tui <file> [args...]  open the live trace inspector
  unigent bake <entry>          bake source-tool schemas for production
  unigent --version             print the installed version

Arguments after <file> are forwarded to the script. A conventional -- separator from command
generators is accepted but not required because Unigent stops parsing at <file>. Bun shebangs are
honored. TUI mode requires Bun.
`;
const DEVELOPMENT_LOADER_PREFIX = "--developmentLoader=";
const SIGNAL_EXIT_CODE_BASE = 128;
const INTERRUPTED_EXIT_CODE = 130;

interface InternalArguments {
  readonly developmentLoader: string | undefined;
  readonly commandArguments: readonly string[];
}

function parseInternalArguments(arguments_: readonly string[]): InternalArguments {
  const [first, ...remaining] = arguments_;
  return first?.startsWith(DEVELOPMENT_LOADER_PREFIX) === true
    ? {
        developmentLoader: first.slice(DEVELOPMENT_LOADER_PREFIX.length),
        commandArguments: remaining,
      }
    : { developmentLoader: undefined, commandArguments: arguments_ };
}

function packageEntry(name: "register" | "tui"): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const extension of ["js", "ts", "tsx"] as const) {
    const candidate = resolve(here, `${name}.${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`unigent: ${name} entry not found`);
}

function signalExitCode(signal: NodeJS.Signals): number {
  return SIGNAL_EXIT_CODE_BASE + operatingSystemConstants.signals[signal];
}

function requireBun(): void {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (probe.error !== undefined) {
    throw new Error(
      "TUI mode requires Bun. Install it from https://bun.sh, then rerun `unigent tui`.",
    );
  }
}

async function spawnExitCode(executable: string, arguments_: readonly string[]): Promise<number> {
  return await new Promise<number>((resolveCode, reject) => {
    const environment = childProcessEnvironment({
      [TRACE_TRANSPORT_ENVIRONMENT_VARIABLE]: undefined,
    });
    const child = spawn(executable, arguments_, { env: environment, stdio: "inherit" });
    let interrupted = false;
    const forwardInterrupt = (): void => {
      interrupted = true;
      child.kill("SIGINT");
    };
    process.on("SIGINT", forwardInterrupt);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", forwardInterrupt);
      resolveCode(
        interrupted
          ? INTERRUPTED_EXIT_CODE
          : (code ?? (signal === null ? 1 : signalExitCode(signal))),
      );
    });
  });
}

async function execute(
  command: RunCommand,
  developmentLoader: string | undefined,
): Promise<number> {
  const runtime = runtimeInvocation(
    await detectScriptRuntime(command.sourceFile),
    process.execPath,
  );
  const developmentPreload =
    developmentLoader !== undefined && runtime.kind === "node"
      ? ["--import", developmentLoader]
      : [];
  if (command.mode === "run") {
    return await spawnExitCode(runtime.executable, [
      ...runtime.arguments,
      ...developmentPreload,
      "--import",
      packageEntry("register"),
      command.sourceFile,
      ...command.scriptArguments,
    ]);
  }
  requireBun();
  return await spawnExitCode("bun", [
    packageEntry("tui"),
    "--node",
    process.execPath,
    "--register",
    packageEntry("register"),
    ...(developmentLoader === undefined ? [] : [`--developmentLoader=${developmentLoader}`]),
    command.sourceFile,
    "--",
    ...command.scriptArguments,
  ]);
}

async function main(): Promise<number> {
  assertSupportedNodeVersion(process.versions.node);
  const internal = parseInternalArguments(process.argv.slice(2));
  const parsed = parseCommand(internal.commandArguments, process.cwd());
  if (parsed.kind === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${packageManifest.version}\n`);
    return 0;
  }
  if (parsed.kind === "bake") {
    process.stdout.write(`${bakeSourceTools(parsed.command.sourceFile)}\n`);
    return 0;
  }
  return await execute(parsed.command, internal.developmentLoader);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`unigent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
