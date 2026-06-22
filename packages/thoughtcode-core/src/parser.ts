// Parsing of the ThoughtCode header grammar. Pure string → structured data; no ArkType, no IO.
// `parseProgram` parses every declaration once into a reusable model — prefer it over the per-construct
// helpers when you need more than one field of a function.

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Index of the first `target` char at bracket/quote depth 0, or -1. */
export function topLevelIndexOf(input: string, target: string): number {
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
export function splitTopLevelArgs(input: string): string[] {
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

/**
 * Extract the declared return-type annotation of a VIBEFUNCTION, i.e. the text after `-> ` on the
 * `VIBEFUNCTION <name>(...)` line. Returns undefined when the function is not found or has no annotation.
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
 * annotation. Untyped declarations are omitted (a missing return type is allowed).
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

// ---- Decorators: one `@name(...)` line directly above a declaration ----

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
 * are allowed; the first non-blank, non-decorator line stops the scan.
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

// ---- Parameters: `(name: type = default, ...)` ----

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

// ---- The whole-program model ----

/** A single parsed VIBEFUNCTION declaration with its header fields, body, and any per-field parse errors. */
export interface VibeFunction {
  name: string;
  params: ParsedParam[];
  returnType?: string;
  decorators: ParsedDecorator[];
  /** The prose the interpreter executes: lines below the declaration, up to the next function. */
  body: string;
  paramErrors: string[];
  decoratorErrors: string[];
}

export interface Program {
  /** Declared functions keyed by name (first declaration wins on duplicates). */
  functions: Map<string, VibeFunction>;
}

const DECLARATION_PATTERN = /^\s*VIBEFUNCTION\s+([A-Za-z_]\w*)\s*\(/;

/**
 * Parse a whole program once into a reusable model. Composes the per-construct parsers for the header
 * fields and slices out each function's body (the lines from its declaration up to the next function's
 * decorator block), so callers avoid re-scanning the source.
 */
export function parseProgram(programText: string): Program {
  const lines = programText.split("\n");
  const declarations: { name: string; index: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = DECLARATION_PATTERN.exec(lines[i]);
    if (match) {
      declarations.push({ name: match[1], index: i });
    }
  }

  const functions = new Map<string, VibeFunction>();
  for (let d = 0; d < declarations.length; d += 1) {
    const { name, index } = declarations[d];
    if (functions.has(name)) {
      continue;
    }
    // Body runs to the next declaration, minus that function's leading decorator/blank lines.
    let end = d + 1 < declarations.length ? declarations[d + 1].index : lines.length;
    while (end - 1 > index && (lines[end - 1].trim() === "" || /^\s*@/.test(lines[end - 1]))) {
      end -= 1;
    }
    const params = parseVibeFunctionParams(programText, name);
    const decorators = parseDecoratorsForFunction(programText, name);
    functions.set(name, {
      name,
      params: params.params,
      returnType: extractReturnType(programText, name),
      decorators: decorators.decorators,
      body: lines.slice(index + 1, end).join("\n").trim(),
      paramErrors: params.errors,
      decoratorErrors: decorators.errors,
    });
  }
  return { functions };
}
