export const VIBE_CALL_TOOL_NAME = "VIBECALL";
export const VIBE_RETURN_TOOL_NAME = "VIBERETURN";
export const VIBE_LOAD_PROGRAM_TOOL_NAME = "VIBELOADPROGRAM";

export interface VibeCallArgs {
  program_file_path: string;
  name: string;
  args: string;
}

export interface VibeReturnArgs {
  value: string;
}

export interface ThoughtcodeToolDescription {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

export interface ThoughtcodeToolParameter {
  name: string;
  type: "string";
  description: string;
  required: true;
}

export const VIBE_CALL_TOOL_PARAMETERS = [
  {
    name: "program_file_path",
    type: "string",
    description: "Path to the Thoughtcode program file where the VIBEFUNCTION is defined.",
    required: true,
  },
  {
    name: "name",
    type: "string",
    description: "Name of the Thoughtcode VIBEFUNCTION to call.",
    required: true,
  },
  {
    name: "args",
    type: "string",
    description: "Serialized arguments to pass to the VIBEFUNCTION.",
    required: true,
  },
] as const satisfies readonly ThoughtcodeToolParameter[];

export const VIBE_RETURN_TOOL_PARAMETERS = [
  {
    name: "value",
    type: "string",
    description: "Serialized return value",
    required: true,
  },
] as const satisfies readonly ThoughtcodeToolParameter[];

export const VIBE_LOAD_PROGRAM_TOOL_PARAMETERS = [
  {
    name: "program_file_path",
    type: "string",
    description: "Path to the Thoughtcode program file to load.",
    required: true,
  },
] as const satisfies readonly ThoughtcodeToolParameter[];

export const VIBE_CALL_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_CALL_TOOL_NAME,
  label: "VIBECALL",
  description:
    "Executes a named Thoughtcode VIBEFUNCTION from a program file. Returns the result as a string.",
  promptSnippet:
    "Use this tool at the point where ThoughtCode program instructs you to make a VIBECALL",
  promptGuidelines: [
  ],
};

export const VIBE_RETURN_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_RETURN_TOOL_NAME,
  label: "VIBERETURN",
  description:
    "Send a return value from inside of a VIBEFUNCTION.",
  promptSnippet:
    "Use this tool at the point where ThoughtCode program instructs you to make a VIBERETURN",
  promptGuidelines: [
  ],
};

export const VIBE_LOAD_PROGRAM_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_LOAD_PROGRAM_TOOL_NAME,
  label: "VIBELOADPROGRAM",
  description:
    "Loads a ThoughtCode program file: validates its syntax and returns the source on success, or a syntax error on failure. " +
    "Always use this tool to read a ThoughtCode program — never read it with cat or the read tool.",
  promptSnippet:
    "Use this tool to read any ThoughtCode program file before executing it",
  promptGuidelines: [
    "Always load a ThoughtCode program with the VIBELOADPROGRAM tool, never with `cat` or the `read` tool — VIBELOADPROGRAM validates the program's syntax before returning its source.",
    "If VIBELOADPROGRAM reports a syntax error, stop execution immediately and report the error instead of guessing or running the program.",
  ],
};

export const THOUGHTCODE_TOOL_DESCRIPTIONS = [
  VIBE_CALL_TOOL_DESCRIPTION,
  VIBE_RETURN_TOOL_DESCRIPTION,
  VIBE_LOAD_PROGRAM_TOOL_DESCRIPTION,
] as const;

export const THOUGHTCODE_SYSTEM_PROMPT = [
  "<!-- thoughtcode:begin -->",
  "You are an interpreter executing one VIBEFUNCTION of a ThoughtCode program. Follow these rules exactly:",
  "0. Read the ThoughtCode program ONLY with the VIBELOADPROGRAM tool — never with `cat` or the `read` tool. It validates the program's syntax and returns the source. If it reports a syntax error, stop execution immediately and report the error.",
  "1. Interpret the body of the ENTRYPOINT VIBEFUNCTION yourself, statement by statement. Do NOT call the VIBECALL tool for the ENTRYPOINT function itself — you ARE its execution.",
  "2. When execution reaches a `VIBECALL <function>(<args>)` expression, you MUST obtain its value by calling the VIBECALL tool with that function name and args. Never read, inline, simulate, or compute the called function's body yourself — each VIBECALL runs as a separate call. This applies even when the called function is defined in the same file (including recursive self-calls).",
  "3. When execution reaches `VIBERETURN(<value>)`, you MUST report the result by calling the VIBERETURN tool with that value. Never write the return value as a plain-text reply — a value is only returned by calling the VIBERETURN tool.",
  "4. Never assume the result of a VIBECALL. The called VIBEFUNCTION runs independently — it may interpret differently, recurse, or have been changed — so its return value is not knowable in advance. Call it to learn the value, even when you believe you can predict it. You are interpreting, not solving.",
  "5. A VIBECALL is isolated: the callee cannot see your variables and you cannot see its. The only things crossing the boundary are the args you pass in and the single value it returns. Each invocation, including each recursive one, has its own fresh variables.",
  "<!-- thoughtcode:end -->",
].join("\n");

const THOUGHTCODE_SYSTEM_PROMPT_MARKER = "<!-- thoughtcode:begin -->";

export const THOUGHTCODE_SUBAGENT_FAILED_MESSAGE = "ThoughtCode subagent failed.";
export const THOUGHTCODE_SUBAGENT_ABORTED_BEFORE_PROMPT_MESSAGE = "ThoughtCode subagent aborted before prompt start.";
export const THOUGHTCODE_MISSING_VIBE_RETURN_MESSAGE = "Finished without calling VIBERETURN.";
export const THOUGHTCODE_MISSING_VIBE_RETURN_PROGRESS_STEP = "failed missing VIBERETURN";
export const THOUGHTCODE_MAX_VIBE_RETURN_TYPE_FAILURES = 3;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the declared return-type annotation of a VIBEFUNCTION from program text, i.e. the text after
 * `-> ` on the `VIBEFUNCTION <name>(...)` line. Returns undefined when the function is not found or has
 * no annotation. The annotation is an ArkType definition (a bare string for scalars/expressions, or
 * JSON for structural types); parsing/validation is the caller's job.
 */
export function extractReturnType(programText: string, functionName: string): string | undefined {
  const pattern = new RegExp(`^\\s*VIBEFUNCTION\\s+${escapeRegExp(functionName)}\\s*\\([^)]*\\)\\s*->\\s*(.+?)\\s*$`, "m");
  const match = pattern.exec(programText);
  const annotation = match?.[1]?.trim();
  return annotation ? annotation : undefined;
}

/** True if the program declares a `VIBEFUNCTION <name>(...)`, with or without a return-type annotation. */
export function hasVibeFunction(programText: string, functionName: string): boolean {
  return new RegExp(`^\\s*VIBEFUNCTION\\s+${escapeRegExp(functionName)}\\s*\\(`, "m").test(programText);
}

/**
 * List every `VIBEFUNCTION <name>(...) -> <returnType>` declaration that carries a return-type
 * annotation. Untyped declarations are omitted (a missing return type is allowed). Used by syntax
 * validation to check each declared return type.
 */
export function listVibeFunctionReturnTypes(programText: string): { name: string; returnType: string }[] {
  const pattern = /^\s*VIBEFUNCTION\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*->\s*(.+?)\s*$/gm;
  const declarations: { name: string; returnType: string }[] = [];
  for (let match = pattern.exec(programText); match !== null; match = pattern.exec(programText)) {
    declarations.push({ name: match[1], returnType: match[2].trim() });
  }
  return declarations;
}

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

export const THOUGHTCODE_VIBE_RETURN_REMINDER_MESSAGE =
  "You ended your turn without calling the VIBERETURN tool. A VIBEFUNCTION must report its result by calling " +
  "VIBERETURN tool as per program instructions. Do not respond in plain text — call the VIBERETURN tool now.";
export const THOUGHTCODE_MAX_VIBE_RETURN_REMINDERS = 3;

export function buildVibeCallFailureMessage(status: string, message: string): string {
  return `${VIBE_CALL_TOOL_NAME} ${status}: ${message}`;
}

export function buildCannotSpawnThoughtcodeSubagentMessage(reason: string): string {
  return `Cannot spawn ThoughtCode subagent: ${reason}`;
}

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
    `Then start executing it at the VIBEFUNCTION corresponding to the ENTRYPOINT, using the ENTRYPOINT_ARGS as its arguments.`
  ].join("\n");
}
