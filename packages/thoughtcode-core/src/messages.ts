// Operator/agent-facing message strings and the limits that govern the subagent loop.

import { VIBE_CALL_TOOL_NAME } from "./tool-defs.js";

export const THOUGHTCODE_SUBAGENT_FAILED_MESSAGE = "ThoughtCode subagent failed.";
export const THOUGHTCODE_SUBAGENT_ABORTED_BEFORE_PROMPT_MESSAGE = "ThoughtCode subagent aborted before prompt start.";
export const THOUGHTCODE_MISSING_VIBE_RETURN_MESSAGE = "Finished without calling VIBERETURN.";
export const THOUGHTCODE_MISSING_VIBE_RETURN_PROGRESS_STEP = "failed missing VIBERETURN";
export const THOUGHTCODE_MAX_VIBE_RETURN_TYPE_FAILURES = 3;

export const THOUGHTCODE_VIBE_RETURN_REMINDER_MESSAGE =
  "You ended your turn without finishing the VIBEFUNCTION. A VIBEFUNCTION must end by calling the VIBERETURN tool " +
  "with its result, or — only if no correct value can be produced — the VIBETHROW tool with an error message. " +
  "Do not respond in plain text — call VIBERETURN (or VIBETHROW) now.";
export const THOUGHTCODE_MAX_VIBE_RETURN_REMINDERS = 3;

export function buildVibeFunctionNotFoundMessage(functionName: string, programFilePath: string): string {
  return `VIBEFUNCTION \`${functionName}\` is not defined in ${programFilePath}.`;
}

export function buildVibeLoadProgramUnreadableMessage(programFilePath: string): string {
  return `Could not read ThoughtCode program at ${programFilePath}. Stop execution and report this error.`;
}

export function buildVibeProgramSyntaxErrorMessage(programFilePath: string, errors: string[]): string {
  return [
    `Syntax error in ThoughtCode program at ${programFilePath}:`,
    ...errors.map((error) => `  - ${error}`),
    "Stop execution; do not run this program until the error is fixed.",
  ].join("\n");
}

export function buildVibeCallFailureMessage(status: string, message: string): string {
  return `${VIBE_CALL_TOOL_NAME} ${status}: ${message}`;
}

/**
 * Failure message for a VIBECALL whose callee deliberately VIBETHREW. Distinct from
 * buildVibeCallFailureMessage so the caller (and logs) can tell an intentional program throw apart
 * from an infrastructure failure (no model, transport error, crash).
 */
export function buildVibeCallThrewMessage(message: string): string {
  return `${VIBE_CALL_TOOL_NAME} threw: ${message}`;
}

export function buildCannotSpawnThoughtcodeSubagentMessage(reason: string): string {
  return `Cannot spawn ThoughtCode subagent: ${reason}`;
}
