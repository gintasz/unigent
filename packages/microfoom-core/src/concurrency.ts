// Run-local capacity gate for concurrent TOP-LEVEL turns — the work-in-progress
// limit (maxConcurrentRootTurns). A top-level turn holds its permit for its whole
// life and disposes it when it settles; nested foom_call turns are exempt at the
// call site (they never acquire), so the permit is never released across a tool
// boundary and re-entry can't deadlock. Admission is FIFO, so a queued top-level
// turn starts only when a running one frees its slot (run-to-completion).

import { FoomCancelledError } from "./errors.js";

interface ConcurrencyLease {
  dispose: () => void;
}

interface QueueEntry {
  readonly limit: number;
  readonly resolve: (lease: ConcurrencyLease) => void;
  readonly reject: (error: FoomCancelledError) => void;
  readonly signal: AbortSignal;
  onAbort: (() => void) | undefined;
}

const NOOP_LEASE: ConcurrencyLease = {
  dispose(): void {
    // Uncapped (or exempt nested) turns have no permit to dispose.
  },
};

/** A FIFO, abort-aware capacity gate for concurrent top-level turns in one run. */
class ConcurrencyGate {
  private active = 0;
  private readonly queue: QueueEntry[] = [];

  public async acquire(limit: number | undefined, signal: AbortSignal): Promise<ConcurrencyLease> {
    if (limit === undefined) {
      return NOOP_LEASE;
    }
    if (signal.aborted) {
      throw new FoomCancelledError("the agent run was aborted");
    }
    if (this.queue.length === 0 && this.active < limit) {
      this.active += 1;
      return this.makeLease();
    }
    return new Promise<ConcurrencyLease>((resolve, reject) => {
      const entry: QueueEntry = { limit, resolve, reject, signal, onAbort: undefined };
      entry.onAbort = (): void => {
        this.remove(entry);
        reject(new FoomCancelledError("the agent run was aborted"));
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private makeLease(): ConcurrencyLease {
    let held = true;
    return {
      dispose: (): void => {
        if (!held) {
          return;
        }
        held = false;
        this.release();
      },
    };
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const [entry] = this.queue;
      if (entry === undefined || this.active >= entry.limit) {
        return;
      }
      this.queue.shift();
      this.removeAbort(entry);
      this.active += 1;
      entry.resolve(this.makeLease());
    }
  }

  private remove(entry: QueueEntry): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    this.removeAbort(entry);
  }

  private removeAbort(entry: QueueEntry): void {
    if (entry.onAbort !== undefined) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = undefined;
    }
  }
}

export type { ConcurrencyLease };
export { ConcurrencyGate };
