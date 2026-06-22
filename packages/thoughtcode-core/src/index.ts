import { type } from "arktype";

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

export const VIBE_THROW_TOOL_DESCRIPTION: ThoughtcodeToolDescription = {
  name: VIBE_THROW_TOOL_NAME,
  label: "VIBETHROW",
  description:
    "End the current VIBEFUNCTION with an error instead of a value. Use when the ThoughtCode program is faulty " +
    "or the task genuinely cannot be completed. Takes a message explaining what went wrong. Last resort — prefer " +
    "VIBERETURN whenever a correct value can be produced.",
  promptSnippet:
    "Use this tool to abort a VIBEFUNCTION with an error when no correct VIBERETURN value can be produced",
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

/** List every declared VIBEFUNCTION name, in source order. */
export function listVibeFunctionNames(programText: string): string[] {
  const pattern = /^\s*VIBEFUNCTION\s+([A-Za-z_]\w*)\s*\(/gm;
  const names: string[] = [];
  for (let match = pattern.exec(programText); match !== null; match = pattern.exec(programText)) {
    names.push(match[1]);
  }
  return names;
}

export function buildVibeFunctionNotFoundMessage(functionName: string, programFilePath: string): string {
  return `VIBEFUNCTION \`${functionName}\` is not defined in ${programFilePath}.`;
}

// ---------------------------------------------------------------------------
// Decorator parsing (interface layer). A decorator is one `@name(...)` line
// directly above a VIBEFUNCTION declaration. We hand-parse the trivial outer
// `@name(args)` shape and delegate every value literal to JSON.parse, so we
// never reinvent string/number/escaping handling. Semantics (what each
// decorator does) live in the runtime registry, not here.
// ---------------------------------------------------------------------------

export interface ParsedDecorator {
  name: string;
  /** Present when called with a single positional argument, e.g. `@model("opus")`. */
  positional?: unknown;
  /** Keyword arguments, e.g. `@retry(times=3)`. Empty when none. */
  kwargs: Record<string, unknown>;
}

export interface DecoratorParseResult {
  decorators: ParsedDecorator[];
  errors: string[];
}

/** Index of the first `target` char at bracket/quote depth 0, or -1. */
function topLevelIndexOf(input: string, target: string): number {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") {
      depth += 1;
    } else if (ch === "]" || ch === "}" || ch === ")") {
      depth -= 1;
    } else if (ch === target && depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Split on top-level commas only — ignores commas inside strings, [], {}, (). */
function splitTopLevelArgs(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let current = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") {
      depth += 1;
    } else if (ch === "]" || ch === "}" || ch === ")") {
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseLiteral(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw.trim()) };
  } catch {
    return { ok: false };
  }
}

function parseDecoratorLine(line: string): ParsedDecorator | { error: string } {
  const match = /^\s*@([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(line);
  if (!match) {
    return { error: `Malformed decorator: ${line.trim()}` };
  }
  const name = match[1];
  const inner = match[2];
  const kwargs: Record<string, unknown> = {};
  let positional: unknown;
  let hasPositional = false;

  if (inner !== undefined && inner.trim() !== "") {
    for (const part of splitTopLevelArgs(inner)) {
      const kw = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(part);
      if (kw) {
        const value = parseLiteral(kw[2]);
        if (!value.ok) {
          return { error: `@${name}: invalid value for ${kw[1]} (strings must be double-quoted): ${kw[2].trim()}` };
        }
        kwargs[kw[1]] = value.value;
      } else {
        if (hasPositional) {
          return { error: `@${name}: only one positional argument is allowed` };
        }
        const value = parseLiteral(part);
        if (!value.ok) {
          return { error: `@${name}: invalid argument (strings must be double-quoted): ${part}` };
        }
        positional = value.value;
        hasPositional = true;
      }
    }
    if (hasPositional && Object.keys(kwargs).length > 0) {
      return { error: `@${name}: cannot mix positional and keyword arguments` };
    }
  }

  return hasPositional ? { name, positional, kwargs } : { name, kwargs };
}

/**
 * Parse the decorator lines directly above a VIBEFUNCTION declaration. Blank lines between decorators
 * are allowed; the first non-blank, non-decorator line stops the scan. Returns parsed decorators in
 * source order plus any per-line parse errors.
 */
export function parseDecoratorsForFunction(programText: string, functionName: string): DecoratorParseResult {
  const lines = programText.split("\n");
  const declPattern = new RegExp(`^\\s*VIBEFUNCTION\\s+${escapeRegExp(functionName)}\\s*\\(`);
  let declIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (declPattern.test(lines[i])) {
      declIndex = i;
      break;
    }
  }
  if (declIndex === -1) {
    return { decorators: [], errors: [] };
  }

  const decoratorLines: string[] = [];
  for (let i = declIndex - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }
    if (/^\s*@/.test(line)) {
      decoratorLines.unshift(line);
      continue;
    }
    break;
  }

  const decorators: ParsedDecorator[] = [];
  const errors: string[] = [];
  for (const line of decoratorLines) {
    const parsed = parseDecoratorLine(line);
    if ("error" in parsed) {
      errors.push(parsed.error);
    } else {
      decorators.push(parsed);
    }
  }
  return { decorators, errors };
}

// ---------------------------------------------------------------------------
// Parameter declarations (input side of the interface). The param list of a
// VIBEFUNCTION header — `(name: type = default, ...)` — parsed deterministically.
// Types are ArkType expressions (validated by the caller); defaults are JSON
// literals. Mirrors the return-type/decorator approach.
// ---------------------------------------------------------------------------

export interface ParsedParam {
  name: string;
  /** ArkType type expression, or undefined for an untyped param. */
  type?: string;
  /** Default value (JSON literal), present only when `hasDefault` is true. */
  default?: unknown;
  hasDefault: boolean;
}

export interface ParamParseResult {
  params: ParsedParam[];
  errors: string[];
}

function parseParam(part: string): ParsedParam | { error: string } {
  let declaration = part;
  let defaultRaw: string | undefined;
  const eqIndex = topLevelIndexOf(part, "=");
  if (eqIndex >= 0) {
    declaration = part.slice(0, eqIndex);
    defaultRaw = part.slice(eqIndex + 1);
  }

  let name = declaration.trim();
  let type: string | undefined;
  const colonIndex = topLevelIndexOf(declaration, ":");
  if (colonIndex >= 0) {
    name = declaration.slice(0, colonIndex).trim();
    type = declaration.slice(colonIndex + 1).trim() || undefined;
  }
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return { error: `invalid parameter name: ${declaration.trim()}` };
  }

  if (defaultRaw === undefined) {
    return { name, type, hasDefault: false };
  }
  const parsed = parseLiteral(defaultRaw);
  if (!parsed.ok) {
    return { error: `parameter \`${name}\`: default must be a JSON literal (strings double-quoted): ${defaultRaw.trim()}` };
  }
  return { name, type, default: parsed.value, hasDefault: true };
}

/** Parse the declared parameter list of a VIBEFUNCTION from the program header. */
export function parseVibeFunctionParams(programText: string, functionName: string): ParamParseResult {
  const pattern = new RegExp(`^\\s*VIBEFUNCTION\\s+${escapeRegExp(functionName)}\\s*\\(([^)]*)\\)`, "m");
  const match = pattern.exec(programText);
  if (!match) {
    return { params: [], errors: [] };
  }
  const params: ParsedParam[] = [];
  const errors: string[] = [];
  for (const part of splitTopLevelArgs(match[1])) {
    const parsed = parseParam(part);
    if ("error" in parsed) {
      errors.push(parsed.error);
    } else {
      params.push(parsed);
    }
  }
  return { params, errors };
}

export interface CallArgsParseResult {
  values: Record<string, unknown>;
  errors: string[];
}

/** Parse a VIBECALL's serialized args string: named `key=value` with JSON-literal values. */
export function parseVibeCallArgs(argsString: string): CallArgsParseResult {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const part of splitTopLevelArgs(argsString)) {
    const eqIndex = topLevelIndexOf(part, "=");
    if (eqIndex < 0) {
      errors.push(`argument must be \`name=value\` (named arguments only): ${part}`);
      continue;
    }
    const name = part.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) {
      errors.push(`invalid argument name: ${name}`);
      continue;
    }
    const parsed = parseLiteral(part.slice(eqIndex + 1));
    if (!parsed.ok) {
      errors.push(`argument \`${name}\`: value must be a JSON literal (strings double-quoted): ${part.slice(eqIndex + 1).trim()}`);
      continue;
    }
    values[name] = parsed.value;
  }
  return { values, errors };
}

/** Serialize bound args back to the `name=value` string form for the subagent prompt. */
export function serializeVibeCallArgs(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Type system + program validation (the deterministic "language" layer). Pure,
// ArkType-only — no agent/runtime dependency, so the CLI and the pi extension
// share it. Runtime concerns (reading files, applying a VibeRunConfig to a run)
// live in pi-thoughtcode.
// ---------------------------------------------------------------------------

export type ReturnTypeCheck = { ok: true } | { ok: false; message: string };
export type ProgramSyntaxCheck = { ok: true } | { ok: false; errors: string[] };

/** Deterministic run configuration assembled from a VIBEFUNCTION's decorators. */
export interface VibeRunConfig {
  /** Override the model used to execute this VIBEFUNCTION (matched by id or `provider/id`). */
  modelId?: string;
  /** Reasoning level for the subagent. */
  thinkingLevel?: "off" | "low" | "medium" | "high";
  /** Abort + throw if the VIBEFUNCTION runs longer than this. */
  timeoutMs?: number;
  /** Abort + throw if the VIBEFUNCTION's own token cost exceeds this many USD. */
  budgetUsd?: number;
}

const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

interface DecoratorSpec {
  apply(config: VibeRunConfig, decorator: ParsedDecorator): string | undefined;
}

function singlePositional(decorator: ParsedDecorator): { value: unknown } | { error: string } {
  if (Object.keys(decorator.kwargs).length > 0) {
    return { error: `@${decorator.name} takes a single positional argument, not keyword arguments` };
  }
  if (decorator.positional === undefined) {
    return { error: `@${decorator.name} requires an argument` };
  }
  return { value: decorator.positional };
}

/** Registry of known decorators. Add a behavior here = one entry; no prompt rules involved. */
export const DECORATOR_REGISTRY: Record<string, DecoratorSpec> = {
  model: {
    apply(config, decorator) {
      const arg = singlePositional(decorator);
      if ("error" in arg) return arg.error;
      if (typeof arg.value !== "string") return "@model expects a string model id";
      config.modelId = arg.value;
      return undefined;
    },
  },
  thinking: {
    apply(config, decorator) {
      const arg = singlePositional(decorator);
      if ("error" in arg) return arg.error;
      if (typeof arg.value !== "string" || !(THINKING_LEVELS as readonly string[]).includes(arg.value)) {
        return `@thinking expects one of: ${THINKING_LEVELS.join(", ")}`;
      }
      config.thinkingLevel = arg.value as VibeRunConfig["thinkingLevel"];
      return undefined;
    },
  },
  timeout: {
    apply(config, decorator) {
      const arg = singlePositional(decorator);
      if ("error" in arg) return arg.error;
      if (typeof arg.value !== "number" || !Number.isFinite(arg.value) || arg.value <= 0) {
        return "@timeout expects a positive number of seconds";
      }
      config.timeoutMs = Math.round(arg.value * 1000);
      return undefined;
    },
  },
  budget: {
    apply(config, decorator) {
      const arg = singlePositional(decorator);
      if ("error" in arg) return arg.error;
      if (typeof arg.value !== "number" || !Number.isFinite(arg.value) || arg.value <= 0) {
        return "@budget expects a positive number (USD)";
      }
      config.budgetUsd = arg.value;
      return undefined;
    },
  },
};

/** Turn parsed decorators into a run config, collecting validation errors (unknown name, bad args). */
export function buildVibeRunConfig(decorators: ParsedDecorator[]): { config: VibeRunConfig; errors: string[] } {
  const config: VibeRunConfig = {};
  const errors: string[] = [];
  for (const decorator of decorators) {
    const spec = DECORATOR_REGISTRY[decorator.name];
    if (!spec) {
      errors.push(`Unknown decorator @${decorator.name}. Known: ${Object.keys(DECORATOR_REGISTRY).join(", ")}.`);
      continue;
    }
    const error = spec.apply(config, decorator);
    if (error) errors.push(error);
  }
  return { config, errors };
}

/**
 * Coerce a ThoughtCode type annotation into an ArkType definition. Structural types (objects/tuples)
 * are JSON and parse to a JS structure; scalar/expression types are bare ArkType strings and pass
 * through. No bespoke parser — JSON.parse plus ArkType.
 */
function toArkDefinition(annotation: string): unknown {
  try {
    return JSON.parse(annotation);
  } catch {
    return annotation;
  }
}

/** VIBERETURN values arrive as strings; JSON-decode so numbers/objects validate, else keep raw. */
function toValue(rawValue: string): unknown {
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

/** True if the annotation compiles to a usable ArkType validator. */
export function isParsableReturnType(annotation: string): boolean {
  try {
    type(toArkDefinition(annotation) as never);
    return true;
  } catch {
    return false;
  }
}

/** Validate an already-decoded value against an ArkType annotation (malformed annotation = no constraint). */
export function validateValue(value: unknown, annotation: string): ReturnTypeCheck {
  let validator: (data: unknown) => unknown;
  try {
    validator = type(toArkDefinition(annotation) as never) as unknown as (data: unknown) => unknown;
  } catch {
    return { ok: true };
  }
  const out = validator(value);
  if (out instanceof type.errors) {
    return { ok: false, message: out.summary };
  }
  return { ok: true };
}

/** Validate a VIBERETURN value (a string) against a declared return-type annotation. */
export function checkReturnValue(rawValue: string, annotation: string): ReturnTypeCheck {
  return validateValue(toValue(rawValue), annotation);
}

/**
 * Validate the syntax of a whole ThoughtCode program: declared return types, param types, defaults,
 * and decorators must all be well-formed. Untyped functions/params are allowed. Pure — no file IO.
 */
export function validateProgramSyntax(programText: string): ProgramSyntaxCheck {
  const errors: string[] = [];
  for (const { name, returnType } of listVibeFunctionReturnTypes(programText)) {
    if (!isParsableReturnType(returnType)) {
      errors.push(
        `VIBEFUNCTION \`${name}\` declares an unrecognized return type \`${returnType}\`. ` +
          `Use a valid ArkType expression — e.g. number, number.integer, string, boolean, "number > 0", or '"ok" | "fail"'.`,
      );
    }
  }
  for (const name of listVibeFunctionNames(programText)) {
    const decorators = parseDecoratorsForFunction(programText, name);
    for (const error of decorators.errors) {
      errors.push(`VIBEFUNCTION \`${name}\`: ${error}`);
    }
    for (const error of buildVibeRunConfig(decorators.decorators).errors) {
      errors.push(`VIBEFUNCTION \`${name}\`: ${error}`);
    }
    const params = parseVibeFunctionParams(programText, name);
    for (const error of params.errors) {
      errors.push(`VIBEFUNCTION \`${name}\`: ${error}`);
    }
    for (const param of params.params) {
      if (param.type && !isParsableReturnType(param.type)) {
        errors.push(`VIBEFUNCTION \`${name}\`: parameter \`${param.name}\` declares an unrecognized type \`${param.type}\`.`);
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
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
  "You ended your turn without finishing the VIBEFUNCTION. A VIBEFUNCTION must end by calling the VIBERETURN tool " +
  "with its result, or — only if no correct value can be produced — the VIBETHROW tool with an error message. " +
  "Do not respond in plain text — call VIBERETURN (or VIBETHROW) now.";
export const THOUGHTCODE_MAX_VIBE_RETURN_REMINDERS = 3;

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
