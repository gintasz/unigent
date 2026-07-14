import type { JsonSchema } from "./backend.js";
import { AgentConfigError } from "./errors.js";
import { type OutputSchema, parseSchema, projectJsonSchema } from "./schema.js";

/** Source-visible function accepted as a zero-wrapper tool. */
export type SourceToolFunction = (...args: never[]) => unknown;

/** Portable tool usable when TypeScript source is unavailable. */
export interface ToolDefinition {
  readonly kind: "tool";
  readonly name: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly checkpointKey?: string;
  readonly parameters: JsonSchema;
  readonly execute: (input: unknown) => Promise<unknown>;
}

/** Options for a portable explicit tool. */
export interface ToolOptions<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  /** Explicit checkpoint identity when the implementation closes over mutable values. */
  readonly checkpointKey?: string;
  readonly input: OutputSchema<Input>;
  readonly execute: (input: Input) => Output | Promise<Output>;
}

/** Define a portable tool with authored runtime and JSON schemas. */
export function tool<Input, Output>(options: ToolOptions<Input, Output>): ToolDefinition {
  if (options.name.trim().length === 0 || options.description.trim().length === 0) {
    throw new AgentConfigError("tool name and description must be non-empty");
  }
  const schema = options.input as OutputSchema<unknown>;
  const parameters = projectJsonSchema(schema);
  return {
    kind: "tool",
    name: options.name,
    description: options.description,
    parameters,
    checkpointKey: options.checkpointKey ?? Function.prototype.toString.call(options.execute),
    ...(options.promptSnippet === undefined ? {} : { promptSnippet: options.promptSnippet }),
    ...(options.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: options.promptGuidelines }),
    execute: async (input: unknown): Promise<unknown> => {
      const parsed = await parseSchema(schema, input);
      if (parsed.error !== undefined) {
        throw new AgentConfigError(parsed.error);
      }
      return options.execute(parsed.value as Input);
    },
  };
}

/** Internally compiled callable tool. */
export interface CompiledTool {
  readonly name: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: JsonSchema;
  readonly checkpointKey: string;
  readonly invoke: (input: unknown) => Promise<unknown>;
}

/** Compile a portable tool to the runtime-neutral representation. */
export function compilePortableTool(definition: ToolDefinition): CompiledTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    checkpointKey: definition.checkpointKey ?? Function.prototype.toString.call(definition.execute),
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
    ...(definition.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: definition.promptGuidelines }),
    invoke: definition.execute,
  };
}
