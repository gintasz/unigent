import { channel } from "node:diagnostics_channel";
import type { AgentUsage } from "./usage.js";

/** Common envelope carried by every first-class trace event. */
interface EventEnvelope {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sequence: number;
  readonly timestamp: string;
}

/** Normalized append-only event stream. */
type AgentEvent = EventEnvelope &
  (
    | {
        readonly type: "span_start";
        readonly name: string;
        readonly kind: "run" | "tool";
        readonly backend?: string;
        readonly model?: string;
        readonly agent?: string;
        readonly scopePath?: readonly string[];
      }
    | {
        readonly type: "span_end";
        readonly durationMs: number;
        readonly usage: AgentUsage;
        readonly outcome: "succeeded" | "failed" | "cancelled";
        readonly error?: string;
      }
    | { readonly type: "system_prompt"; readonly text: string }
    | { readonly type: "user_prompt"; readonly text: string }
    | { readonly type: "reasoning"; readonly text: string }
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "repair"; readonly attempt: number; readonly error: string }
    | {
        readonly type: "log";
        readonly message: string;
        readonly level: "info" | "warn" | "error";
      }
    | {
        readonly type: "annotate";
        readonly attributes: Readonly<Record<string, unknown>>;
      }
    | {
        readonly type: "checkpoint";
        readonly key: string;
        readonly action: "hit" | "miss" | "wait" | "write";
      }
    | {
        readonly type: "tool_call";
        readonly callId: string;
        readonly name: string;
        readonly input: unknown;
      }
    | {
        readonly type: "tool_result";
        readonly callId: string;
        readonly name: string;
        readonly output: unknown;
        readonly isError: boolean;
      }
  );

/** Immutable trace snapshot. */
interface AgentTrace {
  readonly traceId: string;
  readonly events: readonly AgentEvent[];
}

type PendingEvent = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, "traceId" | "sequence" | "timestamp">
    : never
  : never;

type RunControlEvent =
  | {
      readonly type: "run_start";
      readonly traceId: string;
      readonly spanId: string;
      readonly abort: (reason?: unknown) => void;
    }
  | { readonly type: "run_end"; readonly traceId: string; readonly spanId: string };

/** Single-writer replayable event log. */
class EventLog {
  private readonly recorded: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly endedSpans = new Set<string>();
  private ended = false;

  public constructor(public readonly traceId: string) {}

  public emit(event: PendingEvent): void {
    const envelope: EventEnvelope = {
      traceId: this.traceId,
      spanId: event.spanId,
      sequence: this.recorded.length,
      timestamp: new Date().toISOString(),
      ...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
    };
    const recorded: AgentEvent = { ...event, ...envelope };
    this.recorded.push(recorded);
    if (recorded.type === "span_end") {
      this.endedSpans.add(recorded.spanId);
    }
    if (traceEventChannel.hasSubscribers) {
      try {
        traceEventChannel.publish(recorded);
      } catch {
        // Instrumentation is best-effort and cannot become a runtime failure path.
      }
    }
    for (const wake of this.waiters) {
      wake();
    }
    this.waiters.clear();
  }

  public end(): void {
    this.ended = true;
    for (const wake of this.waiters) {
      wake();
    }
    this.waiters.clear();
  }

  public snapshot(): AgentTrace {
    return { traceId: this.traceId, events: [...this.recorded] };
  }

  private includesEvent(includedSpans: Set<string> | undefined, event: AgentEvent): boolean {
    if (includedSpans === undefined) {
      return true;
    }
    if (
      event.type === "span_start" &&
      event.parentSpanId !== undefined &&
      includedSpans.has(event.parentSpanId)
    ) {
      includedSpans.add(event.spanId);
    }
    return includedSpans.has(event.spanId);
  }

  private iterableEnded(rootSpanId: string | undefined, cursor: number): boolean {
    if (cursor < this.recorded.length) {
      return false;
    }
    return rootSpanId === undefined ? this.ended : this.endedSpans.has(rootSpanId);
  }

  private async waitForEvent(): Promise<void> {
    await new Promise<void>((resolve) => this.waiters.add(resolve));
  }

  public iterable(rootSpanId?: string): AsyncIterable<AgentEvent> {
    const log = this;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent, void, undefined> {
        let cursor = 0;
        const includedSpans = rootSpanId === undefined ? undefined : new Set([rootSpanId]);
        while (!log.iterableEnded(rootSpanId, cursor)) {
          const event = log.recorded[cursor];
          if (event === undefined) {
            await log.waitForEvent();
            continue;
          }
          cursor += 1;
          if (log.includesEvent(includedSpans, event)) {
            yield event;
          }
        }
      },
    };
  }
}

const TRACE_EVENT_CHANNEL = "unigent.trace.v1";
const traceEventChannel = channel(TRACE_EVENT_CHANNEL);
const RUN_CONTROL_CHANNEL = "unigent.control.v1";
const runControlChannel = channel(RUN_CONTROL_CHANNEL);

function publishRunControl(event: RunControlEvent): void {
  if (!runControlChannel.hasSubscribers) {
    return;
  }
  try {
    runControlChannel.publish(event);
  } catch {
    // Instrumentation is best-effort and cannot become a runtime failure path.
  }
}

export type { AgentEvent, AgentTrace, EventEnvelope, RunControlEvent };
export { EventLog, publishRunControl, RUN_CONTROL_CHANNEL, TRACE_EVENT_CHANNEL };
