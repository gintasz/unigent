// The subprocess seam shared by the CLI harness adapters. Each adapter builds its
// own argv (Claude vs Codex flags differ), but the spawn mechanics are identical:
// launch the binary, expose its stdout as an async line stream, collect stderr, and
// — on a synchronous spawn failure (e.g. a missing binary) — degrade to an empty
// line stream so the caller surfaces it as an unavailable harness rather than
// throwing.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/** A running turn's subprocess: its stdout lines, a kill switch, and any stderr. */
export interface CliProcess {
  readonly lines: AsyncIterable<string>;
  kill: () => void;
  /** Collected stderr (+ spawn error), available once `lines` is exhausted. */
  stderr: () => string;
}

/** Options for {@link spawnLineProcess}. */
export interface SpawnLineOptions {
  /** Working directory for the child (defaults to the parent's cwd). */
  readonly cwd?: string;
  /** Environment for the child (defaults to inheriting the parent's). */
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Run inside the spawn try, just before spawning (e.g. write a temp file the
   *  argv references). A throw here is treated as a spawn failure. */
  readonly prepare?: () => void;
  /** Run when the child exits OR fails to spawn (e.g. to clean up temp files). */
  readonly onExit?: () => void;
}

/** Spawn `command args`, exposing stdout as an async line stream. A synchronous
 *  spawn failure yields an empty-line process carrying the error as stderr. */
export function spawnLineProcess(
  command: string,
  args: readonly string[],
  options: SpawnLineOptions = {},
): CliProcess {
  let child: ChildProcessByStdio<null, Readable, Readable>;
  let stderr = "";
  try {
    options.prepare?.();
    child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    options.onExit?.();
    const message = String(error);
    return {
      lines: (async function* () {
        /* spawn failed: emit no lines */
      })(),
      kill: () => {
        /* nothing to kill: process never spawned */
      },
      stderr: () => message,
    };
  }

  child.on("error", (error) => {
    stderr += String(error);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  if (options.onExit !== undefined) {
    child.on("close", options.onExit);
  }

  return {
    lines: createInterface({ input: child.stdout }),
    kill: () => child.kill("SIGTERM"),
    stderr: () => stderr,
  };
}
