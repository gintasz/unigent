// Tool identities and their LLM-facing parameter/description tables.

export const VIBE_CALL_TOOL_NAME = "VIBECALL";
export const VIBE_RETURN_TOOL_NAME = "VIBERETURN";
export const VIBE_LOAD_PROGRAM_TOOL_NAME = "VIBELOADPROGRAM";
export const VIBE_THROW_TOOL_NAME = "VIBETHROW";

export interface VibeCallArgs {
  program_file_path: string;
  name: string;
  args: string;
}

export interface VibeReturnArgs {
  value: string;
}

export interface VibeThrowArgs {
  message: string;
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
    description:
      "Arguments for the VIBEFUNCTION as comma-separated name=value pairs with JSON-literal values " +
      '(strings double-quoted), e.g. `n=2, label="ok"`. Evaluate any expressions to concrete values first. ' +
      "Pass an empty string when the function takes no arguments.",
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

export const VIBE_THROW_TOOL_PARAMETERS = [
  {
    name: "message",
    type: "string",
    description:
      "Explanation of what went wrong and why execution cannot continue. State whether it is a program error " +
      "(the ThoughtCode code is faulty) or a runtime error (a step genuinely cannot be completed).",
    required: true,
  },
] as const satisfies readonly ThoughtcodeToolParameter[];

export const VIBE_CALL_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_CALL_TOOL_NAME,
  label: "VIBECALL",
  description: "Executes a named Thoughtcode VIBEFUNCTION from a program file. Returns the result as a string.",
  promptSnippet: "Use this tool at the point where ThoughtCode program instructs you to make a VIBECALL",
  promptGuidelines: [],
};

export const VIBE_RETURN_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_RETURN_TOOL_NAME,
  label: "VIBERETURN",
  description: "Send a return value from inside of a VIBEFUNCTION.",
  promptSnippet: "Use this tool at the point where ThoughtCode program instructs you to make a VIBERETURN",
  promptGuidelines: [],
};

export const VIBE_LOAD_PROGRAM_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_LOAD_PROGRAM_TOOL_NAME,
  label: "VIBELOADPROGRAM",
  description:
    "Loads a ThoughtCode program file: validates its syntax and returns the source on success, or a syntax error on failure. " +
    "Always use this tool to read a ThoughtCode program — never read it with cat or the read tool.",
  promptSnippet: "Use this tool to read any ThoughtCode program file before executing it",
  promptGuidelines: [
    "Always load a ThoughtCode program with the VIBELOADPROGRAM tool, never with `cat` or the `read` tool — VIBELOADPROGRAM validates the program's syntax before returning its source.",
    "If VIBELOADPROGRAM reports a syntax error, stop execution immediately and report the error instead of guessing or running the program.",
  ],
};

export const VIBE_THROW_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_THROW_TOOL_NAME,
  label: "VIBETHROW",
  description:
    "End the current VIBEFUNCTION with an error instead of a value. Use when the ThoughtCode program is faulty " +
    "or the task genuinely cannot be completed. Takes a message explaining what went wrong. Last resort — prefer " +
    "VIBERETURN whenever a correct value can be produced.",
  promptSnippet: "Use this tool to abort a VIBEFUNCTION with an error when no correct VIBERETURN value can be produced",
  promptGuidelines: [
    "Call VIBETHROW only as a last resort: when the program's instructions are faulty/contradictory/impossible, or a required step genuinely cannot be completed. Never use it to avoid effort, to skip an ambiguous-but-resolvable step, or in place of VIBERETURN for a valid-but-undesirable result.",
  ],
};

export const THOUGHTCODE_TOOL_DESCRIPTIONS = [
  VIBE_CALL_TOOL_DESCRIPTION,
  VIBE_RETURN_TOOL_DESCRIPTION,
  VIBE_LOAD_PROGRAM_TOOL_DESCRIPTION,
  VIBE_THROW_TOOL_DESCRIPTION,
] as const;
