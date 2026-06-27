// Public result wrappers at the facade (F6). An AgentResult is a PromiseLike that
// also exposes abort() and a live usage snapshot; an AgentTextStream additionally
// yields chunks. Consumers await Promises and catch the thrown taxonomy (F7).
// Cancellation is an AbortController; abort() rejects the awaiter with
// FoomtimeCancelledError.

import type { AgentUsage } from "./usage.js";

/**
 * The awaitable result of an agent turn. Awaiting yields the value; abort()
 * cancels an in-flight run (the awaiter then rejects with FoomtimeCancelledError).
 * An un-awaited result self-handles its own cancellation rejection, so abort()
 * never surfaces an unhandledRejection.
 */
export interface AgentResult<T> extends PromiseLike<T> {
  abort(reason?: unknown): void;
  readonly usage: AgentUsage;
}

/**
 * A streaming text result. `for await` yields chunks; awaiting resolves to the
 * full joined message (chunks are buffered and replayed even after iterating).
 */
export interface AgentTextStream extends AgentResult<string>, AsyncIterable<string> {}

/** How a run is driven: it receives the abort signal and reports live usage. */
export interface ResultDriver<T> {
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly usage: () => AgentUsage;
}

function attach<T>(
  promise: Promise<T>,
  controller: AbortController,
  usage: () => AgentUsage,
): AgentResult<T> {
  // Pre-handle so an aborted-but-unawaited result never trips unhandledRejection.
  promise.catch(() => undefined);
  return {
    // biome-ignore lint/suspicious/noThenProperty: AgentResult is intentionally PromiseLike (F6 facade).
    then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
    abort: (reason?: unknown) => controller.abort(reason),
    get usage() {
      return usage();
    },
  };
}

/** Build a plain (non-streaming) AgentResult from a driver. */
export function makeResult<T>(driver: ResultDriver<T>): AgentResult<T> {
  const controller = new AbortController();
  const promise = driver.run(controller.signal);
  return attach(promise, controller, driver.usage);
}

/** A sink the runner pushes text chunks into while a streaming turn proceeds. */
export interface StreamSink {
  readonly push: (chunk: string) => void;
  readonly end: () => void;
  readonly fail: (error: unknown) => void;
}

/** Build an AgentTextStream plus the sink the runner feeds. */
export function makeTextStream(driver: ResultDriver<string>): {
  readonly stream: AgentTextStream;
  readonly sink: StreamSink;
} {
  const buffer: string[] = [];
  const waiters: Array<(result: IteratorResult<string>) => void> = [];
  let done = false;
  let failure: { error: unknown } | undefined;
  let cursor = 0;

  const sink: StreamSink = {
    push: (chunk) => {
      buffer.push(chunk);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter({ value: buffer[cursor++] as string, done: false });
    },
    end: () => {
      done = true;
      for (const waiter of waiters.splice(0)) {
        if (cursor < buffer.length) waiter({ value: buffer[cursor++] as string, done: false });
        else waiter({ value: undefined, done: true });
      }
    },
    fail: (error) => {
      failure = { error };
      done = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
  };

  const controller = new AbortController();
  const promise = driver.run(controller.signal);

  const iterator: AsyncIterator<string> = {
    next: () =>
      new Promise<IteratorResult<string>>((resolve, reject) => {
        if (failure !== undefined) {
          reject(failure.error);
          return;
        }
        if (cursor < buffer.length) {
          resolve({ value: buffer[cursor++] as string, done: false });
          return;
        }
        if (done) {
          resolve({ value: undefined, done: true });
          return;
        }
        waiters.push(resolve);
      }),
  };

  const base = attach(promise, controller, driver.usage);
  const stream: AgentTextStream = {
    // biome-ignore lint/suspicious/noThenProperty: AgentTextStream is intentionally PromiseLike (F6 facade).
    then: base.then.bind(base),
    abort: base.abort.bind(base),
    get usage() {
      return base.usage;
    },
    [Symbol.asyncIterator]: () => iterator,
  };
  return { stream, sink };
}
