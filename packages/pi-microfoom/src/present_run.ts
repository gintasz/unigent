// Trace presentation for the pi harness. A microfoom program runs as a separate
// programmatic sub-session (createPiOpenSession), so pi's own turn/tool events
// never see it — its trace arrives through the run's `onEvent` (core AgentEvent).
// This module turns that stream into two pi surfaces:
//
//   • a live widget above the editor while the run is in flight (span tree with
//     rolled-up duration/tokens/cost), cleared when the run settles; and
//   • a permanent, collapsible trace block in the transcript afterwards.
//
// Row shaping + metric strings come from @microfoom/trace-view (shared with the
// CLI panel); this file only paints them onto pi (plain lines for the widget,
// Box/Text + theme for the transcript message). TUI-guarded: with no UI the widget
// is skipped and only the transcript entry is recorded.

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type AgentEvent, buildRunTree, type RunNode } from "@microfoom/core/trace";
import { fmtSummary, renderRows, type TraceSpanRow } from "@microfoom/trace-view";

/** customType for the transcript trace message + its renderer. */
const TRACE_TYPE = "microfoom-trace";
/** Coalesce live-widget redraws so a burst of events doesn't thrash the TUI. */
const REDRAW_MS = 60;
/** Cap an inlined result string so one large value can't blow up the row (OB1). */
const MAX_RESULT = 200;

/** Persisted payload for one finished run; the renderer rebuilds the view from it. */
interface TraceDetails {
  readonly name: string;
  readonly tree: RunNode;
  readonly result: unknown;
}

/** CLI span colors mapped onto theme roles (program→accent … scope→warning). */
const kindColor: Record<TraceSpanRow["kind"], ThemeColor> = {
  program: "accent",
  method: "mdLink",
  turn: "success",
  scope: "warning",
};

function resultText(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  const value = text ?? "undefined";
  return value.length > MAX_RESULT ? `${value.slice(0, MAX_RESULT)}…` : value;
}

/** One-line collapsed view: name → result, with the rolled-up run summary. */
function collapsedText(details: TraceDetails, theme: Theme): string {
  const summary = fmtSummary(details.tree.usage, details.tree.durationMs);
  const head = `${theme.fg("success", "◆")} ${theme.fg("accent", `microfoom ${details.name}`)}`;
  return `${head}  ->  ${resultText(details.result)}  ${theme.fg("dim", summary)}`;
}

/** Expanded view: the full themed span tree plus the result line. */
function expandedText(details: TraceDetails, theme: Theme): string {
  const lines = [`${theme.fg("success", "◆")} ${theme.fg("accent", `microfoom ${details.name}`)}`];
  for (const row of renderRows(details.tree)) {
    const indent = "  ".repeat(row.depth);
    if (row.type === "span") {
      const glyph = theme.fg(kindColor[row.kind], row.glyph);
      lines.push(`${indent}${glyph} ${row.label}  ${theme.fg("dim", row.metrics)}`);
    } else {
      lines.push(theme.fg("dim", `${indent}   • ${row.message}`));
    }
  }
  lines.push(theme.fg("dim", `result: ${resultText(details.result)}`));
  return lines.join("\n");
}

/** Register the transcript renderer once, at extension load. */
export function registerTraceRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<TraceDetails>(TRACE_TYPE, (message, { expanded }, theme) => {
    const details = message.details;
    if (details === undefined) return undefined;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(expanded ? expandedText(details, theme) : collapsedText(details, theme)));
    return box;
  });
}

/** Plain (un-themed) lines for the live widget; the box supplies the framing. */
function widgetLines(name: string, events: readonly AgentEvent[]): string[] {
  const lines = [`microfoom ▸ ${name}  running`];
  for (const row of renderRows(buildRunTree([...events]))) {
    const indent = "  ".repeat(row.depth);
    lines.push(
      row.type === "span"
        ? `${indent}${row.glyph} ${row.label}  ${row.metrics}`
        : `${indent}   • ${row.message}`,
    );
  }
  return lines;
}

let widgetSeq = 0;

/** Drives one run's presentation: feed `onEvent`, then `done`/`fail` to settle. */
export interface RunPresenter {
  /** Wire this into runProgram's `onEvent`. */
  readonly onEvent: (event: AgentEvent) => void;
  /** Run finished: clear the live widget and record the transcript trace. */
  done(result: unknown): void;
  /** Run failed: clear the live widget (the caller surfaces the error). */
  fail(): void;
}

/** How the run was invoked — decides what the trace injects into LLM context. */
export interface PresentationOptions {
  /**
   * Put the result into the LLM-visible `content` (a command's only channel to
   * the agent). False for a tool run, whose result already reaches the agent via
   * the tool return — the trace then injects only a provenance + cost note, not a
   * duplicate result.
   */
  readonly injectResult: boolean;
}

/**
 * Start presenting a run. The live widget is shown only when the context has UI;
 * the transcript trace is always recorded so non-TUI runs still keep a record.
 *
 * `content` (vs the renderer-only `details`) is mapped to a user-role message by
 * pi's `convertToLlm`, so it is the agent-visible text. It is prefixed with
 * `[microfoom:<name>]` so the agent reads it as a program result, not user input.
 */
export function startRunPresentation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  options: PresentationOptions,
): RunPresenter {
  const events: AgentEvent[] = [];
  const live = ctx.hasUI;
  widgetSeq += 1;
  const key = `${TRACE_TYPE}:${widgetSeq}`;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    ctx.ui.setWidget(key, widgetLines(name, events), { placement: "aboveEditor" });
  };
  const clearWidget = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (live) ctx.ui.setWidget(key, undefined);
  };

  return {
    onEvent: (event) => {
      events.push(event);
      if (live && timer === undefined) timer = setTimeout(flush, REDRAW_MS);
    },
    done: (result) => {
      clearWidget();
      const tree = buildRunTree(events);
      // Command runs inject the result (their only channel to the agent); tool runs
      // inject only a provenance + cost note (the result already reached the agent
      // via the tool return). Both are prefixed so the agent doesn't mistake the
      // user-role message pi derives from `content` for user input.
      const content = options.injectResult
        ? `[microfoom:${name}] returned: ${resultText(result)}`
        : `[microfoom:${name}] ran (${fmtSummary(tree.usage, tree.durationMs)})`;
      pi.sendMessage<TraceDetails>({
        customType: TRACE_TYPE,
        content,
        display: true,
        details: { name, tree, result },
      });
    },
    fail: clearWidget,
  };
}
