export const VIBE_CALL_TOOL_NAME = "VIBECALL";
export const VIBE_RETURN_TOOL_NAME = "VIBERETURN";

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

export const VIBE_CALL_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_CALL_TOOL_NAME,
  label: "VIBECALL",
  description:
    "Thoughtcode call primitive. Spawns a subagent to execute a named VIBEMETHOD from a program file with serialized string arguments.",
  promptSnippet:
    "VIBECALL(program_file_path, name, args) - spawn a subagent to execute a named Thoughtcode VIBEMETHOD from a program file.",
  promptGuidelines: [
    "Use VIBECALL when the Thoughtcode program asks you to call another VIBEMETHOD.",
    "Pass the program file path in program_file_path, the target method name in name, and a serialized representation of its arguments in args.",
  ],
};

export const VIBE_RETURN_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_RETURN_TOOL_NAME,
  label: "VIBERETURN",
  description:
    "Thoughtcode return primitive. Inside a VIBECALL subagent, returns a serialized string value to the caller and stops the subagent turn.",
  promptSnippet:
    "VIBERETURN(value) - inside a VIBECALL subagent, return a serialized Thoughtcode value to the caller and stop the subagent turn.",
  promptGuidelines: [
    "Use VIBERETURN only while executing inside a VIBECALL subagent.",
    "Do not use VIBERETURN in the parent session after VIBECALL returns; respond with the VIBECALL result as normal text.",
    "The value must be a string. Do not add commentary to the returned value.",
  ],
};

export const THOUGHTCODE_TOOL_DESCRIPTIONS = [
  VIBE_CALL_TOOL_DESCRIPTION,
  VIBE_RETURN_TOOL_DESCRIPTION,
] as const;

export function buildVibeCallSubagentPrompt(args: VibeCallArgs): string {
  return [
    `ENTRYPOINT = ${args.name}`,
    `ENTRYPOINT_ARGS = ${args.args}`,
    `Read ${args.program_file_path} and literally execute it as if you were an interpreter.`,
  ].join("\n");
}
