// Intrinsic run events (F8 substrate). The core emits these; the opt-in trace
// entry (`@microfoom/core/trace`) is just a typed subscriber. Core never imports
// the trace surface — it only produces this neutral event stream.

import type { AgentUsage } from "./usage.js";

/** A trace event. The built-in run panel and any exporter subscribe to these. */
export type AgentEvent =
  | {
      readonly type: "span_start";
      readonly span: string;
      readonly parent?: string;
      readonly name: string;
      /** What produced the span — drives the render glyph. Absent for manual scopes. */
      readonly kind?: "program" | "method" | "turn" | "scope";
    }
  | {
      readonly type: "span_end";
      readonly span: string;
      readonly durationMs: number;
      readonly usage: AgentUsage;
    }
  | { readonly type: "turn_start"; readonly span: string; readonly label?: string }
  | { readonly type: "foom_call"; readonly span: string; readonly method: string }
  | { readonly type: "repair"; readonly span: string; readonly attempt: number }
  | {
      readonly type: "log";
      readonly span: string;
      readonly message: string;
      readonly level: "info" | "warn" | "error";
    }
  | {
      readonly type: "annotate";
      readonly span: string;
      readonly attributes: Record<string, unknown>;
    };

/** An OTel-style sink: the runtime feeds it the event stream. */
export interface AgentTraceExporter {
  export(event: AgentEvent): void;
}
