// The interpreter system prompt and the per-call subagent prompt.

import type { VibeCallArgs } from "./tool-defs.js";

export const THOUGHTCODE_SYSTEM_PROMPT = [
  "<!-- thoughtcode:begin -->",
  "You are an interpreter executing one VIBEFUNCTION of a ThoughtCode program. Follow these rules exactly:",
  "0. Read the ThoughtCode program ONLY with the VIBELOADPROGRAM tool — never with `cat` or the `read` tool. It validates the program's syntax and returns the source. If it reports a syntax error, stop execution immediately and report the error.",
  "1. Interpret the body of the ENTRYPOINT VIBEFUNCTION yourself, statement by statement. Do NOT call the VIBECALL tool for the ENTRYPOINT function itself — you ARE its execution.",
  "2. When execution reaches a `VIBECALL <function>(<args>)` expression, you MUST obtain its value by calling the VIBECALL tool with that function name and args. Pass args as comma-separated name=value pairs with JSON-literal values (strings double-quoted), e.g. `n=2, label=\"ok\"`; evaluate any expressions (like `n - 1`) to concrete values first, and pass an empty string when there are no args. Never read, inline, simulate, or compute the called function's body yourself — each VIBECALL runs as a separate call. This applies even when the called function is defined in the same file (including recursive self-calls).",
  "3. When execution reaches `VIBERETURN(<value>)`, you MUST report the result by calling the VIBERETURN tool with that value. Never write the return value as a plain-text reply — a value is only returned by calling the VIBERETURN tool.",
  "4. Never assume the result of a VIBECALL. The called VIBEFUNCTION runs independently — it may interpret differently, recurse, or have been changed — so its return value is not knowable in advance. Call it to learn the value, even when you believe you can predict it. You are interpreting, not solving.",
  "5. A VIBECALL is isolated: the callee cannot see your variables and you cannot see its. The only things crossing the boundary are the args you pass in and the single value it returns. Each invocation, including each recursive one, has its own fresh variables.",
  "6. Every VIBEFUNCTION ends exactly one way: VIBERETURN a value, or VIBETHROW an error — never both, never neither. End by calling the VIBETHROW tool when execution reaches an explicit `VIBETHROW(<message>)` statement, OR when no correct value can be produced: the program is faulty (contradictory/impossible/undefined references) or a required step genuinely cannot be completed. Do NOT VIBETHROW to avoid effort, to skip an ambiguous-but-resolvable step, or instead of returning a valid-but-undesirable result (e.g. \"not found\" is a normal VIBERETURN, not a throw). When in doubt, interpret reasonably and VIBERETURN.",
  "7. A VIBECALL whose callee throws surfaces to you as a failed tool result. Handle it as the program directs (e.g. a fallback); otherwise VIBETHROW to propagate the failure to your own caller.",
  "<!-- thoughtcode:end -->",
].join("\n");

const THOUGHTCODE_SYSTEM_PROMPT_MARKER = "<!-- thoughtcode:begin -->";

export function appendThoughtcodeSystemPrompt(systemPrompt: string): string {
  if (systemPrompt.includes(THOUGHTCODE_SYSTEM_PROMPT_MARKER)) {
    return systemPrompt;
  }
  return systemPrompt.trimEnd() ? `${systemPrompt.trimEnd()}\n\n${THOUGHTCODE_SYSTEM_PROMPT}` : THOUGHTCODE_SYSTEM_PROMPT;
}

export function buildVibeCallSubagentPrompt(args: VibeCallArgs): string {
  return [
    `ENTRYPOINT = ${args.name}`,
    `ENTRYPOINT_ARGS = ${args.args}`,
    `You are called to execute a VIBEFUNCTION.`,
    `Load the ThoughtCode program at ${args.program_file_path} with the VIBELOADPROGRAM tool (never with cat or the read tool).`,
    `Then start executing it at the VIBEFUNCTION corresponding to the ENTRYPOINT, using the ENTRYPOINT_ARGS as its arguments.`,
  ].join("\n");
}
