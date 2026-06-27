// Opt-in instrumentation entry point (F8). Importing this augments the run context
// with the trace surface (scope / onEvent / export); the common path imports none
// of it, and core never depends on this module. The runtime methods always exist
// on the context — this entry surfaces their types and adds a renderer/exporter.

import type { AgentEvent, AgentTraceExporter } from "../events.js";
import type { AgentScope } from "../program.js";
import {
  type AgentUsage,
  combineUsage,
  emptyUsage,
  toAgentUsage,
  type UsageAccount,
} from "../usage.js";

export type { AgentEvent, AgentTraceExporter } from "../events.js";
export type { AgentScope } from "../program.js";
export type { AgentUsage } from "../usage.js";

declare module "../program.js" {
  interface AgentProgramContext<TProgram extends object> {
    /** Name a manual span; returns a handle whose work attributes to it. */
    scope(name: string): AgentScope;
    /** Subscribe to the intrinsic event stream. */
    onEvent(handler: (event: AgentEvent) => void): void;
    /** Pipe the event stream to an exporter (OTel / Langfuse / …). */
    export(exporter: AgentTraceExporter): void;
  }
}

/** Render one trace event as a single human-readable line (OB1). */
export function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case "span_start":
      return `▸ ${event.name} (${event.span})`;
    case "span_end":
      return `■ ${event.span} ${event.durationMs}ms`;
    case "turn_start":
      return `→ turn ${event.span}${event.label !== undefined ? ` "${event.label}"` : ""}`;
    case "foom_call":
      return `· ${event.span} foom_call ${event.method}`;
    case "repair":
      return `· ${event.span} repair #${event.attempt}`;
    case "log":
      return `[${event.level}] ${event.span} ${event.message}`;
    case "annotate":
      return `# ${event.span} ${JSON.stringify(event.attributes)}`;
  }
}

/** An exporter that prints each event via `formatEvent` to the console. */
export const consoleExporter: AgentTraceExporter = {
  export: (event) => {
    console.log(formatEvent(event));
  },
};

/** One log line attached to a span. */
export interface RunLog {
  readonly message: string;
  readonly level: "info" | "warn" | "error";
}

/**
 * One node of the run's span tree — pure data, no presentation. A frontend (CLI,
 * harness panel) renders this however it likes. `usage` is rolled up: a node's
 * own measured usage (real only on turn leaves) plus all descendants'.
 */
export interface RunNode {
  readonly span: string;
  readonly name: string;
  readonly kind: "program" | "method" | "turn" | "scope";
  /** Wall-clock duration; absent while the span is still open. */
  readonly durationMs: number | undefined;
  /** Rolled-up usage for this subtree. */
  readonly usage: AgentUsage;
  readonly annotations: Record<string, unknown>;
  readonly logs: readonly RunLog[];
  /** Methods the agent foom_called within this span. */
  readonly foomCalls: readonly string[];
  /** Count of repair attempts recorded within this span. */
  readonly repairs: number;
  readonly children: readonly RunNode[];
  /** `false` while the span is still open (no span_end seen). */
  readonly settled: boolean;
}

function toAccount(usage: AgentUsage): UsageAccount {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
    costUsd: usage.costUsd,
    calls: usage.calls,
    maxCallDepth: usage.maxCallDepth,
  };
}

interface MutableNode {
  span: string;
  name: string;
  kind: RunNode["kind"];
  parent: string | undefined;
  durationMs: number | undefined;
  ownUsage: UsageAccount;
  annotations: Record<string, unknown>;
  logs: RunLog[];
  foomCalls: string[];
  repairs: number;
  settled: boolean;
  children: MutableNode[];
}

function ensure(map: Map<string, MutableNode>, span: string): MutableNode {
  let node = map.get(span);
  if (node === undefined) {
    node = {
      span,
      name: span,
      kind: "scope",
      parent: undefined,
      durationMs: undefined,
      ownUsage: emptyUsage,
      annotations: {},
      logs: [],
      foomCalls: [],
      repairs: 0,
      settled: false,
      children: [],
    };
    map.set(span, node);
  }
  return node;
}

function freeze(node: MutableNode): RunNode {
  const children = node.children.map(freeze);
  // Roll usage up: own (real only on turn leaves) + all descendants.
  let account = node.ownUsage;
  for (const child of children) account = combineUsage(account, toAccount(child.usage));
  return {
    span: node.span,
    name: node.name,
    kind: node.kind,
    durationMs: node.durationMs,
    usage: toAgentUsage(account),
    annotations: node.annotations,
    logs: node.logs,
    foomCalls: node.foomCalls,
    repairs: node.repairs,
    children,
    settled: node.settled,
  };
}

/**
 * Fold an event stream into the run's span tree (pure). Events arrive in emission
 * order; a span's `span_start` always precedes its end/markers. Returns the single
 * root (the program span) — or a synthetic `run` root if the stream has several
 * top-level spans (e.g. parent-less manual scopes).
 */
export function buildRunTree(events: readonly AgentEvent[]): RunNode {
  const map = new Map<string, MutableNode>();
  for (const event of events) {
    switch (event.type) {
      case "span_start": {
        const node = ensure(map, event.span);
        node.name = event.name;
        if (event.kind !== undefined) node.kind = event.kind;
        node.parent = event.parent;
        break;
      }
      case "span_end": {
        const node = ensure(map, event.span);
        node.durationMs = event.durationMs;
        node.ownUsage = toAccount(event.usage);
        node.settled = true;
        break;
      }
      case "turn_start":
        ensure(map, event.span).kind = "turn";
        break;
      case "foom_call":
        ensure(map, event.span).foomCalls.push(event.method);
        break;
      case "repair":
        ensure(map, event.span).repairs = event.attempt;
        break;
      case "log":
        ensure(map, event.span).logs.push({ message: event.message, level: event.level });
        break;
      case "annotate":
        Object.assign(ensure(map, event.span).annotations, event.attributes);
        break;
    }
  }

  const roots: MutableNode[] = [];
  for (const node of map.values()) {
    if (node.parent !== undefined && map.has(node.parent)) {
      (map.get(node.parent) as MutableNode).children.push(node);
    } else {
      roots.push(node);
    }
  }

  if (roots.length === 1 && roots[0] !== undefined) return freeze(roots[0]);
  return freeze({
    span: "run",
    name: "run",
    kind: "program",
    parent: undefined,
    durationMs: undefined,
    ownUsage: emptyUsage,
    annotations: {},
    logs: [],
    foomCalls: [],
    repairs: 0,
    settled: roots.every((root) => root.settled),
    children: roots,
  });
}
