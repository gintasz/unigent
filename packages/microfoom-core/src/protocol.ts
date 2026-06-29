// The fixed control protocol (F2). The agent affects the program ONLY through
// these four native tools; their effect is dispatched by the core (tools.ts) and
// executed by the harness loop, never parsed from free text. A `{ tool }`-tier
// method is additionally advertised as its own native tool with its derived
// parameter schema (ADR-0003).

/** Reserved native tool names for the control tools. */
export const CONTROL_TOOLS = {
  call: "foom_call",
  return: "foom_return",
  throw: "foom_throw",
  inspect: "foom_inspect",
} as const;

/** One of the four reserved control-tool names (`foom_call` / `foom_return` /
 *  `foom_throw` / `foom_inspect`). */
export type ControlToolName = (typeof CONTROL_TOOLS)[keyof typeof CONTROL_TOOLS];

const CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(CONTROL_TOOLS));

/** True when a tool name is one of the reserved control tools. */
export function isControlTool(name: string): name is ControlToolName {
  return CONTROL_TOOL_NAMES.has(name);
}

/** Code stamped on a `foom_throw` when the agent omits one (`foom_throw` `code`
 *  is optional). `foom_throw` still always carries a code (F7) — this is the fallback. */
export const DEFAULT_THROW_CODE = "error_unspecified";

/**
 * Agent-visible descriptions of the control tools (shown in the tool manifest).
 * Single-sourced here (I1) so the wording is consistent and reviewable, never
 * inline in the dispatcher.
 */
export const CONTROL_TOOL_DESCRIPTIONS: Record<ControlToolName, string> = {
  [CONTROL_TOOLS.call]:
    "Call an exposed microfoom method by name. `arguments` is an object of its parameters (learn it with foom_inspect).",
  [CONTROL_TOOLS.inspect]:
    "Return the parameter schema of an exposed microfoom method so you can build a valid foom_call.",
  [CONTROL_TOOLS.throw]: `Abort the execution with a deliberate error. \`code\` is optional — omit it (it defaults to \`${DEFAULT_THROW_CODE}\`) unless your instructions specify one.`,
  [CONTROL_TOOLS.return]:
    "Return the final structured result of this turn through the machine-readable channel.",
};

/**
 * Description for `foom_return` in a `do` turn — there is no value to return, so the
 * tool takes no arguments and merely signals the task is finished (mirrors `return;`).
 */
export const DONE_RETURN_DESCRIPTION =
  "Signal that this turn's task is complete. Call with NO arguments — this turn returns no value to the program. Do not write a prose summary.";

/**
 * Per-control-tool usage blurb (promptSnippet) — keyed like the descriptions.
 */
export const CONTROL_TOOL_SNIPPETS: Partial<Record<ControlToolName, string>> = {
  // [CONTROL_TOOLS.call]: "If you don't already know a method's argument schema, call foom_inspect on it first.",
  // [CONTROL_TOOLS.inspect]: "Use this method to learn a microfoom method's argument schema before calling it with foom_call"
};

/**
 * Per-control-tool usage rules (promptGuidelines) — keyed like the descriptions.
 */
export const CONTROL_TOOL_GUIDELINES: Partial<Record<ControlToolName, readonly string[]>> = {};

/**
 * Every tool-result string the model can read back — repair hints and terminal
 * acknowledgements. Single-sourced (I1) and defined once; the dispatcher
 * (tools.ts) references these, never inline literals. `detail` arguments carry
 * already-formatted validation issues. (Developer-facing exception messages are
 * NOT here — those live with the error taxonomy and the agent never sees them.)
 */
export const TOOL_RESULTS = {
  notExposed: (method: string): string => `Method "${method}" is not exposed.`,
  invalidArguments: (detail: string): string => `Invalid arguments: ${detail}`,
  invalidReturn: (detail: string): string => `Invalid return value: ${detail}`,
  raised: "Program raised an error.",
  failed: "Program failed.",
  returned: "Returned.",
  missingReturn:
    "You did not call foom_return. Call foom_return now with the result — or foom_throw if you cannot complete the task or the instructions are defective or contradictory.",
  missingDone:
    "You did not call foom_return. Call foom_return now (with no arguments) to confirm the task is complete — or foom_throw if you cannot complete it or the instructions are defective or contradictory.",
} as const;
