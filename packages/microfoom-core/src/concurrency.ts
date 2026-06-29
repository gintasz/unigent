// Run-local model-turn capacity control. The permit is released while FOOM tool
// handlers run, because tool handlers are deterministic host work and may start
// nested turns; holding capacity through that boundary deadlocks max=1 re-entry.

import { FoomCancelledError } from "./errors.js";

interface ConcurrencyLease {
  release: () => void;
  reacquire: () => Promise<void>;
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
  release(): void {
    // Uncapped runs have no permit to release.
  },
  async reacquire(): Promise<void> {
    // Uncapped runs have no permit to reacquire.
  },
  dispose(): void {
    // Uncapped runs have no permit to dispose.
  },
};

/** A FIFO, abort-aware capacity gate for concurrent model turns in one run. */
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
      return this.makeLease(limit, signal);
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

  private makeLease(limit: number, signal: AbortSignal): ConcurrencyLease {
    const state = { held: true, disposed: false };
    const disposedController = new AbortController();
    const leaseSignal = AbortSignal.any([signal, disposedController.signal]);
    return {
      release: (): void => {
        if (!state.held || state.disposed) {
          return;
        }
        state.held = false;
        this.release();
      },
      reacquire: async (): Promise<void> => {
        if (state.held || state.disposed) {
          return;
        }
        await this.acquire(limit, leaseSignal);
        state.held = true;
      },
      dispose: (): void => {
        state.disposed = true;
        disposedController.abort();
        if (!state.held) {
          return;
        }
        state.held = false;
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
      entry.resolve(this.makeLease(entry.limit, entry.signal));
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
