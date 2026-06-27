// Public surface of @microfoom/trace-view: the frontend-neutral half of run-trace
// presentation. Frontends (CLI text panel, pi TUI widget) import these to shape a
// `@microfoom/core/trace` RunNode tree into rows + formatted metric strings, then
// paint them on their own surface. Re-exports are explicit (no `export *`).

export {
  fmtCost,
  fmtDuration,
  fmtSummary,
  fmtTokens,
} from "./format.js";
export {
  renderRows,
  type TraceLogRow,
  type TraceRow,
  type TraceSpanRow,
} from "./render.js";
