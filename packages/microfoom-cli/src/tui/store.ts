// The TUI's data source. The bun TUI process runs the program in-process (so the
// terminal stdin stays free for OpenTUI's keyboard/mouse input) and pushes the
// run's event stream here. React reads an immutable snapshot via
// useSyncExternalStore. The program finishing does NOT close the TUI — `status`
// flips to done/error and the view stays up until the user quits.

import type { AgentEvent } from "@microfoom/core/trace";

interface RunMeta {
  readonly file: string;
  readonly model: string;
  readonly harness: string;
  readonly input: string;
}

interface TuiSnapshot {
  readonly meta: RunMeta | undefined;
  readonly events: readonly AgentEvent[];
  readonly status: "running" | "done" | "error" | "aborted";
  readonly result: string | undefined;
  readonly error: string | undefined;
  /** Anything the program wrote to stdout/stderr — captured so it renders in the
   *  pane instead of bleeding onto OpenTUI's screen. */
  readonly stdout: string;
}

interface TuiStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TuiSnapshot;
  /** Feed one run event (coalesced into the next render tick). */
  push: (event: AgentEvent) => void;
  /** Capture a chunk the program wrote to stdout/stderr (coalesced). */
  pushStdout: (chunk: string) => void;
  /** Set run metadata (header). */
  setMeta: (meta: RunMeta) => void;
  /** Mark the run settled; the view stays up. */
  done: (result: string | undefined, error: string | undefined) => void;
  /** Mark the run user-aborted (distinct from a failure); the view stays up. */
  aborted: (message: string) => void;
}

const COALESCE_MS = 30;

function createStore(): TuiStore {
  let meta: RunMeta | undefined;
  const events: AgentEvent[] = [];
  let status: TuiSnapshot["status"] = "running";
  let result: string | undefined;
  let error: string | undefined;
  let stdout = "";

  let snapshot: TuiSnapshot = { meta, events, status, result, error, stdout };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const rebuild = (): void => {
    snapshot = { meta, events: events.slice(), status, result, error, stdout };
    for (const listener of listeners) {
      listener();
    }
  };
  // Coalesce bursts of stream deltas into one render tick.
  const schedule = (): void => {
    timer ??= setTimeout(flush, COALESCE_MS);
  };
  const flush = (): void => {
    timer = undefined;
    rebuild();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): TuiSnapshot {
      return snapshot;
    },
    push(event: AgentEvent): void {
      events.push(event);
      schedule();
    },
    pushStdout(chunk: string): void {
      stdout += chunk;
      schedule();
    },
    setMeta(next: RunMeta): void {
      meta = next;
      rebuild();
    },
    done(nextResult: string | undefined, nextError: string | undefined): void {
      status = nextError === undefined ? "done" : "error";
      result = nextResult;
      error = nextError;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = undefined;
      rebuild();
    },
    aborted(message: string): void {
      status = "aborted";
      error = message;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = undefined;
      rebuild();
    },
  };
}

export type { TuiStore };
export { createStore };
