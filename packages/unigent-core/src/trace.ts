/** Opt-in process instrumentation and pure trace projections for frontends. */

import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { AgentEvent, RunControlEvent } from "./events.js";
import { RUN_CONTROL_CHANNEL, TRACE_EVENT_CHANNEL } from "./events.js";
import { type AgentUsage, combineUsage, emptyUsage } from "./usage.js";

interface TraceNode {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: "run" | "tool";
  readonly backend: string | undefined;
  readonly model: string | undefined;
  readonly agent: string | undefined;
  readonly scopePath: readonly string[];
  readonly durationMs: number | undefined;
  readonly usage: AgentUsage;
  readonly outcome: "running" | "succeeded" | "failed" | "cancelled";
  readonly error: string | undefined;
  readonly repairs: number;
  readonly logs: readonly TraceLog[];
  readonly annotations: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly checkpoints: readonly TraceCheckpoint[];
  readonly children: readonly TraceNode[];
}

interface TraceLog {
  readonly message: string;
  readonly level: "info" | "warn" | "error";
}

interface TraceCheckpoint {
  readonly key: string;
  readonly action: "hit" | "miss" | "wait" | "write";
}

interface TraceTree {
  readonly roots: readonly TraceNode[];
  readonly usage: AgentUsage;
  readonly durationMs: number | undefined;
}

interface TraceProjectionSnapshot {
  readonly tree: TraceTree;
  readonly transcript: readonly TranscriptEntry[];
  readonly eventCount: number;
}

type TranscriptEntry =
  | {
      readonly kind: "system" | "user" | "assistant" | "reasoning";
      readonly spanId: string;
      readonly text: string;
    }
  | {
      readonly kind: "tool_call";
      readonly spanId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "tool_result";
      readonly spanId: string;
      readonly name: string;
      readonly output: unknown;
      readonly isError: boolean;
    };

interface MutableTraceNode {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: "run" | "tool";
  backend: string | undefined;
  model: string | undefined;
  agent: string | undefined;
  scopePath: string[];
  durationMs: number | undefined;
  usage: AgentUsage;
  outcome: "running" | "succeeded" | "failed" | "cancelled";
  error: string | undefined;
  repairs: number;
  logs: TraceLog[];
  annotations: Array<Readonly<Record<string, unknown>>>;
  checkpoints: TraceCheckpoint[];
  children: MutableTraceNode[];
}

function snapshotTraceNode(node: MutableTraceNode): TraceNode {
  return {
    ...node,
    scopePath: [...node.scopePath],
    usage: { ...node.usage },
    logs: node.logs.map((log) => ({ ...log })),
    annotations: [...node.annotations],
    checkpoints: node.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    children: node.children.map(snapshotTraceNode),
  };
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "traceId" in value &&
    typeof value.traceId === "string" &&
    "spanId" in value &&
    typeof value.spanId === "string"
  );
}

function subscribeTrace(handler: (event: AgentEvent) => void): () => void {
  const listener = (message: unknown): void => {
    if (isAgentEvent(message)) {
      handler(message);
    }
  };
  subscribe(TRACE_EVENT_CHANNEL, listener);
  return (): void => {
    unsubscribe(TRACE_EVENT_CHANNEL, listener);
  };
}

function subscribeRunControls(handler: (event: RunControlEvent) => void): () => void {
  const listener = (message: unknown): void => {
    if (isRunControlEvent(message)) {
      handler(message);
    }
  };
  subscribe(RUN_CONTROL_CHANNEL, listener);
  return (): void => {
    unsubscribe(RUN_CONTROL_CHANNEL, listener);
  };
}

function isRunControlEvent(message: unknown): message is RunControlEvent {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    !("traceId" in message) ||
    typeof message.traceId !== "string" ||
    !("spanId" in message) ||
    typeof message.spanId !== "string"
  ) {
    return false;
  }
  if (message.type === "run_end") {
    return true;
  }
  return message.type === "run_start" && "abort" in message && typeof message.abort === "function";
}

class TraceProjection {
  private readonly nodes = new Map<string, MutableTraceNode>();
  private readonly roots: MutableTraceNode[] = [];
  private readonly transcript: TranscriptEntry[] = [];
  private readonly openTranscriptEntries = new Map<
    string,
    { readonly kind: "assistant" | "reasoning"; readonly index: number }
  >();
  private usage: AgentUsage = emptyUsage();
  private settledRoots = 0;
  private longestRootDuration: number | undefined;
  private eventCount = 0;

  public append(event: AgentEvent): void {
    this.eventCount += 1;
    if (event.type === "span_start") {
      const node = this.startNode(event);
      const parent =
        event.parentSpanId === undefined ? undefined : this.nodes.get(event.parentSpanId);
      if (parent === undefined) {
        this.roots.push(node);
      } else {
        parent.children.push(node);
      }
    } else if (event.type === "span_end") {
      const node = this.nodes.get(event.spanId);
      if (node !== undefined) {
        this.endNode(node, event);
      }
    } else {
      this.appendNodeEvent(event);
    }
    this.appendTranscript(event);
  }

  public snapshot(): TraceProjectionSnapshot {
    const allRootsSettled = this.roots.length > 0 && this.settledRoots === this.roots.length;
    return {
      tree: {
        roots: this.roots.map(snapshotTraceNode),
        usage: { ...this.usage },
        durationMs: allRootsSettled ? this.longestRootDuration : undefined,
      },
      transcript: this.transcript.map((entry) => ({ ...entry })),
      eventCount: this.eventCount,
    };
  }

  private startNode(event: Extract<AgentEvent, { readonly type: "span_start" }>): MutableTraceNode {
    const node: MutableTraceNode = {
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      name: event.name,
      kind: event.kind,
      backend: event.backend,
      model: event.model,
      agent: event.agent,
      scopePath: [...(event.scopePath ?? [])],
      durationMs: undefined,
      usage: emptyUsage(),
      outcome: "running",
      error: undefined,
      repairs: 0,
      logs: [],
      annotations: [],
      checkpoints: [],
      children: [],
    };
    this.nodes.set(event.spanId, node);
    return node;
  }

  private appendNodeEvent(event: AgentEvent): void {
    const node = this.nodes.get(event.spanId);
    if (node === undefined) {
      return;
    }
    if (event.type === "repair") {
      node.repairs = Math.max(node.repairs, event.attempt);
    } else if (event.type === "log") {
      node.logs.push({ message: event.message, level: event.level });
    } else if (event.type === "annotate") {
      node.annotations.push(event.attributes);
    } else if (event.type === "checkpoint") {
      node.checkpoints.push({ key: event.key, action: event.action });
    }
  }

  private appendStreamingText(kind: "assistant" | "reasoning", spanId: string, text: string): void {
    const open = this.openTranscriptEntries.get(spanId);
    const previous = open === undefined ? undefined : this.transcript[open.index];
    if (
      open?.kind === kind &&
      previous !== undefined &&
      (previous.kind === "assistant" || previous.kind === "reasoning")
    ) {
      this.transcript[open.index] = { ...previous, text: previous.text + text };
      return;
    }
    const index = this.transcript.length;
    this.transcript.push({ kind, spanId, text });
    this.openTranscriptEntries.set(spanId, { kind, index });
  }

  private endNode(
    node: MutableTraceNode,
    event: Extract<AgentEvent, { readonly type: "span_end" }>,
  ): void {
    node.durationMs = event.durationMs;
    node.usage = event.usage;
    node.outcome = event.outcome;
    node.error = event.error;
    if (node.parentSpanId === undefined) {
      this.usage = combineUsage(this.usage, event.usage);
      this.settledRoots += 1;
      this.longestRootDuration = Math.max(this.longestRootDuration ?? 0, event.durationMs);
    }
  }

  private appendTranscript(event: AgentEvent): void {
    switch (event.type) {
      case "system_prompt":
        this.openTranscriptEntries.delete(event.spanId);
        this.transcript.push({ kind: "system", spanId: event.spanId, text: event.text });
        break;
      case "user_prompt":
        this.openTranscriptEntries.delete(event.spanId);
        this.transcript.push({ kind: "user", spanId: event.spanId, text: event.text });
        break;
      case "text":
        this.appendStreamingText("assistant", event.spanId, event.text);
        break;
      case "reasoning":
        this.appendStreamingText("reasoning", event.spanId, event.text);
        break;
      case "tool_call":
        this.openTranscriptEntries.delete(event.spanId);
        this.transcript.push({
          kind: "tool_call",
          spanId: event.spanId,
          name: event.name,
          input: event.input,
        });
        break;
      case "tool_result":
        this.openTranscriptEntries.delete(event.spanId);
        this.transcript.push({
          kind: "tool_result",
          spanId: event.spanId,
          name: event.name,
          output: event.output,
          isError: event.isError,
        });
        break;
      case "span_start":
      case "span_end":
      case "repair":
      case "log":
      case "annotate":
      case "checkpoint":
        if (event.type === "span_end") {
          this.openTranscriptEntries.delete(event.spanId);
        }
        break;
    }
  }
}

function projectEvents(events: readonly AgentEvent[]): TraceProjectionSnapshot {
  const projection = new TraceProjection();
  for (const event of events) {
    projection.append(event);
  }
  return projection.snapshot();
}

function buildTraceTree(events: readonly AgentEvent[]): TraceTree {
  return projectEvents(events).tree;
}

function buildTranscript(events: readonly AgentEvent[]): readonly TranscriptEntry[] {
  return projectEvents(events).transcript;
}

export type { AgentEvent, RunControlEvent } from "./events.js";
export type {
  TraceCheckpoint,
  TraceLog,
  TraceNode,
  TraceProjectionSnapshot,
  TraceTree,
  TranscriptEntry,
};
export { buildTraceTree, buildTranscript, subscribeRunControls, subscribeTrace, TraceProjection };
