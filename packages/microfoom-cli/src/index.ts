// Public surface of @microfoom/cli (programmatic reuse). The bin is `cli.ts`; the
// renderer, panel, loader and fake session are exported so other frontends/tests
// can reuse them. Re-exports are explicit (no `export *`).

/**
 * `@microfoom/cli` — the CLI runner plus its reusable building blocks (renderer,
 * panel, program loader, fake session) for other frontends and tests.
 *
 * @packageDocumentation
 */

/** The version of `@microfoom/cli` this build was published at. */
export const CLI_VERSION = "0.1.0";

export { fakeOpenSession } from "./fake.js";
export {
  fmtCost,
  fmtDuration,
  fmtSummary,
  fmtTokens,
} from "./format.js";
export { loadProgram, type ProgramClass } from "./loader.js";
export { attachPanel, type Panel } from "./panel.js";
export { type RenderOptions, renderRunTree } from "./render.js";
