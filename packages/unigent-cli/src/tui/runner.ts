import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { childProcessEnvironment } from "../environment.js";
import { parseTraceRecord, TRACE_TRANSPORT_ENVIRONMENT_VARIABLE } from "../protocol.js";
import type { RuntimeInvocation } from "../script_runtime.js";
import type { TuiStore } from "./store.js";

interface ScriptRunnerOptions {
  readonly runtime: RuntimeInvocation;
  readonly registerEntry: string;
  readonly sourceFile: string;
  readonly scriptArguments: readonly string[];
}

interface ScriptRunner {
  readonly start: () => void;
  readonly abort: () => void;
  readonly dispose: () => void;
}

const INTERRUPT_GRACE_MILLISECONDS = 1500;

function attachChildStreams(
  child: ChildProcess,
  currentGeneration: number,
  activeGeneration: () => number,
  store: TuiStore,
): void {
  child.stdout?.on("data", (chunk: Buffer) => {
    if (currentGeneration === activeGeneration()) {
      store.pushOutput("stdout", chunk.toString("utf8"));
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (currentGeneration === activeGeneration()) {
      store.pushOutput("stderr", chunk.toString("utf8"));
    }
  });
  const [, , , traceOutput] = child.stdio;
  if (!(traceOutput instanceof Readable)) {
    return;
  }
  const lines = createInterface({ input: traceOutput, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    if (currentGeneration !== activeGeneration()) {
      return;
    }
    const record = parseTraceRecord(line);
    if (record !== undefined) {
      store.pushEvent(record.event);
    }
  });
}

function settleChild(
  store: TuiStore,
  abortRequested: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (abortRequested || signal === "SIGINT" || signal === "SIGKILL") {
    store.settle("cancelled");
  } else if (code === 0) {
    store.settle("succeeded");
  } else {
    store.settle("failed", `Script exited with code ${code ?? 1}`);
  }
}

function createScriptRunner(options: ScriptRunnerOptions, store: TuiStore): ScriptRunner {
  let activeChild: ChildProcess | undefined;
  let generation = 0;
  let abortRequested = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearForceTimer = (): void => {
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer);
      forceTimer = undefined;
    }
  };

  const stop = (force: boolean): void => {
    if (activeChild === undefined || activeChild.exitCode !== null) {
      return;
    }
    activeChild.kill(force ? "SIGKILL" : "SIGINT");
    if (!force) {
      abortRequested = true;
      clearForceTimer();
      forceTimer = setTimeout(() => stop(true), INTERRUPT_GRACE_MILLISECONDS);
    }
  };

  const start = (): void => {
    stop(true);
    clearForceTimer();
    generation += 1;
    abortRequested = false;
    const currentGeneration = generation;
    store.start();
    const child = spawn(
      options.runtime.executable,
      [
        ...options.runtime.arguments,
        "--import",
        options.registerEntry,
        options.sourceFile,
        ...options.scriptArguments,
      ],
      {
        env: childProcessEnvironment({
          FORCE_COLOR: undefined,
          [TRACE_TRANSPORT_ENVIRONMENT_VARIABLE]: "3",
        }),
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    activeChild = child;
    attachChildStreams(child, currentGeneration, () => generation, store);
    child.once("error", (error) => {
      if (currentGeneration === generation) {
        store.settle("failed", error.message);
      }
    });
    child.once("exit", (code, signal) => {
      if (currentGeneration !== generation) {
        return;
      }
      clearForceTimer();
      activeChild = undefined;
      settleChild(store, abortRequested, code, signal);
    });
  };

  return {
    start,
    abort: (): void => stop(false),
    dispose: (): void => {
      generation += 1;
      stop(true);
      clearForceTimer();
    },
  };
}

export { createScriptRunner };
