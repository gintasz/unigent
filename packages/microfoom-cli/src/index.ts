// Public surface of @microfoom/cli (programmatic reuse). The bin is `cli.ts`; the
// renderer, panel, loader and faux session are exported so other frontends/tests
// can reuse them. Re-exports are explicit (no `export *`).

export { fauxOpenSession } from "./faux.js";
export {
  fmtCost,
  fmtDuration,
  fmtSummary,
  fmtTokens,
} from "./format.js";
export { loadProgram, type ProgramClass } from "./loader.js";
export { attachPanel, type Panel } from "./panel.js";
export { type RenderOptions, renderRunTree } from "./render.js";
