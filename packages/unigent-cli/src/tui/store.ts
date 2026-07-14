import type { AgentEvent } from "@unigent/core";
import { TraceProjection, type TraceProjectionSnapshot } from "@unigent/core/trace";

interface TuiSnapshot extends TraceProjectionSnapshot {
  readonly sourceFile: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | undefined;
  readonly runNumber: number;
  readonly startedAt: number;
  readonly revision: number;
}

interface TuiStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => TuiSnapshot;
  readonly start: () => void;
  readonly pushEvent: (event: AgentEvent) => void;
  readonly pushOutput: (stream: "stdout" | "stderr", chunk: string) => void;
  readonly settle: (status: "succeeded" | "failed" | "cancelled", error?: string) => void;
}

interface MutableTuiState {
  projection: TraceProjection;
  status: TuiSnapshot["status"];
  stdout: string;
  stderr: string;
  error: string | undefined;
  runNumber: number;
  startedAt: number;
  revision: number;
}

const COALESCE_MILLISECONDS = 32;
const MAX_OUTPUT_CHARACTERS = 1_000_000;

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_OUTPUT_CHARACTERS) {
    return combined;
  }
  return `[earlier output truncated]\n${combined.slice(-MAX_OUTPUT_CHARACTERS)}`;
}

function projectSnapshot(sourceFile: string, state: MutableTuiState): TuiSnapshot {
  return {
    sourceFile,
    status: state.status,
    stdout: state.stdout,
    stderr: state.stderr,
    error: state.error,
    runNumber: state.runNumber,
    startedAt: state.startedAt,
    revision: state.revision,
    ...state.projection.snapshot(),
  };
}

function createTuiStore(sourceFile: string): TuiStore {
  const state: MutableTuiState = {
    projection: new TraceProjection(),
    status: "running",
    stdout: "",
    stderr: "",
    error: undefined,
    runNumber: 1,
    startedAt: Date.now(),
    revision: 0,
  };
  let snapshot = projectSnapshot(sourceFile, state);
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const rebuild = (): void => {
    snapshot = projectSnapshot(sourceFile, state);
    for (const listener of listeners) {
      listener();
    }
  };
  const flush = (): void => {
    timer = undefined;
    rebuild();
  };
  const schedule = (): void => {
    timer ??= setTimeout(flush, COALESCE_MILLISECONDS);
  };
  const flushNow = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    rebuild();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    getSnapshot: (): TuiSnapshot => snapshot,
    start(): void {
      state.projection = new TraceProjection();
      state.status = "running";
      state.stdout = "";
      state.stderr = "";
      state.error = undefined;
      state.runNumber += 1;
      state.startedAt = Date.now();
      state.revision += 1;
      flushNow();
    },
    pushEvent(event: AgentEvent): void {
      state.projection.append(event);
      state.revision += 1;
      schedule();
    },
    pushOutput(stream: "stdout" | "stderr", chunk: string): void {
      if (stream === "stdout") {
        state.stdout = appendBounded(state.stdout, chunk);
      } else {
        state.stderr = appendBounded(state.stderr, chunk);
      }
      schedule();
    },
    settle(nextStatus: "succeeded" | "failed" | "cancelled", nextError?: string): void {
      state.status = nextStatus;
      state.error = nextError;
      flushNow();
    },
  };
}

export type { TuiSnapshot, TuiStore };
export { createTuiStore };
