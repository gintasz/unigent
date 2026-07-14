import { basename } from "node:path";
import process from "node:process";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { AgentInputError } from "./errors.js";
import { type OutputSchema, parseSchema } from "./schema.js";

type InputPair = readonly [string, string | boolean];
interface ArgsOptions {
  /** One-line explanation shown before usage. */
  readonly description?: string;
  /** Arguments appended to the detected script name in usage output. */
  readonly usage?: string;
}
const NEGATION_PREFIX = "no-";
const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function flagPair(
  name: string,
  inline: string | undefined,
  next: string | undefined,
): { readonly pair: InputPair; readonly consumedNext: boolean } {
  if (name.length === 0) {
    throw new AgentInputError("argument names must not be empty");
  }
  if (name.startsWith(NEGATION_PREFIX) && inline === undefined) {
    return { pair: [name.slice(NEGATION_PREFIX.length), false], consumedNext: false };
  }
  if (inline !== undefined) {
    return { pair: [name, inline], consumedNext: false };
  }
  if (next === undefined || next.startsWith("--")) {
    return { pair: [name, true], consumedNext: false };
  }
  return { pair: [name, next], consumedNext: true };
}

function pairsFromArguments(arguments_: readonly string[]): readonly InputPair[] {
  const pairs: InputPair[] = [];
  let index = 0;
  while (index < arguments_.length) {
    const token = arguments_[index] ?? "";
    if (token === "--") {
      index += 1;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new AgentInputError(`unexpected positional argument: ${token}`);
    }
    const equals = token.indexOf("=");
    const name = equals < 0 ? token.slice(2) : token.slice(2, equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    const parsed = flagPair(name, inline, arguments_[index + 1]);
    pairs.push(parsed.pair);
    index += parsed.consumedNext ? 2 : 1;
  }
  return pairs;
}

function coerceScalar(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed === "number" || typeof parsed === "boolean") {
      return parsed;
    }
  } catch {
    // Non-JSON scalars remain strings.
  }
  return raw;
}

async function parsePositional<Output>(
  arguments_: readonly string[],
  schema: OutputSchema<Output>,
): Promise<Output> {
  const named = arguments_.find((token) => token.startsWith("--"));
  if (named !== undefined) {
    throw new AgentInputError(`cannot mix positional input with named argument: ${named}`);
  }
  const raw = arguments_.join(" ");
  const coerced = coerceScalar(raw);
  const coercedResult = await schema["~standard"].validate(coerced);
  if (coercedResult.issues === undefined) {
    return coercedResult.value;
  }
  if (!Object.is(coerced, raw)) {
    const rawResult = await schema["~standard"].validate(raw);
    if (rawResult.issues === undefined) {
      return rawResult.value;
    }
  }
  const parsed = await parseSchema(schema, raw);
  throw new AgentInputError(parsed.error ?? "positional script input is invalid");
}

function pathSegments(path: string): readonly string[] {
  const segments = path.split(".");
  if (segments.some((segment) => segment.length === 0 || UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new AgentInputError(`unsafe or empty argument path: ${path}`);
  }
  return segments;
}

type InputContainer = Record<string, unknown> | unknown[];

function readContainer(container: InputContainer, key: string): unknown {
  return Array.isArray(container) ? container[Number(key)] : container[key];
}

function writeContainer(container: InputContainer, key: string, value: unknown): void {
  if (Array.isArray(container)) {
    container[Number(key)] = value;
  } else {
    container[key] = value;
  }
}

function isInputContainer(value: unknown): value is InputContainer {
  return typeof value === "object" && value !== null;
}

function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor: InputContainer = root;
  for (const segment of path.slice(0, -1)) {
    const existing = readContainer(cursor, segment);
    if (existing !== undefined && !isInputContainer(existing)) {
      throw new AgentInputError(`argument path conflicts at ${path.join(".")}`);
    }
    const next: InputContainer = existing ?? {};
    writeContainer(cursor, segment, next);
    cursor = next;
  }
  writeContainer(cursor, path.at(-1) ?? "", value);
}

function getPath(root: unknown, path: readonly string[]): unknown {
  let cursor = root;
  for (const segment of path) {
    if (!isInputContainer(cursor)) {
      return;
    }
    cursor = readContainer(cursor, segment);
  }
  return cursor;
}

function assemble(pairs: readonly InputPair[], coerce: boolean): Record<string, unknown> {
  const grouped = new Map<string, Array<string | boolean>>();
  for (const [name, value] of pairs) {
    const values = grouped.get(name);
    if (values === undefined) {
      grouped.set(name, [value]);
    } else {
      values.push(value);
    }
  }
  const root: Record<string, unknown> = {};
  const convert = (value: string | boolean): unknown =>
    coerce && typeof value === "string" ? coerceScalar(value) : value;
  for (const [name, values] of grouped) {
    const value = values.length === 1 ? convert(values[0] ?? "") : values.map(convert);
    setPath(root, pathSegments(name), value);
  }
  return root;
}

function issuePath(path: StandardSchemaV1.Issue["path"]): readonly string[] {
  if (!Array.isArray(path)) {
    return [];
  }
  return path.map((segment: unknown) =>
    typeof segment === "object" && segment !== null && "key" in segment
      ? String(segment.key)
      : String(segment),
  );
}

async function uncoerceRejectedFields<Output>(
  schema: OutputSchema<Output>,
  candidate: Record<string, unknown>,
  raw: Readonly<Record<string, unknown>>,
  pairCount: number,
): Promise<Output> {
  for (let attempt = 0; attempt <= pairCount; attempt += 1) {
    const result = await schema["~standard"].validate(candidate);
    if (result.issues === undefined) {
      return result.value;
    }
    let changed = false;
    for (const issue of result.issues) {
      const path = issuePath(issue.path);
      if (path.length === 0) {
        continue;
      }
      const current = getPath(candidate, path);
      const original = getPath(raw, path);
      if (typeof original === "string" && current !== original) {
        setPath(candidate, path, original);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  const parsed = await parseSchema(schema, candidate);
  throw new AgentInputError(parsed.error ?? "script arguments are invalid");
}

/** Parse an explicit argv array as typed named arguments or scalar positional input. */
async function parseArgs(arguments_: readonly string[]): Promise<Record<string, unknown>>;
async function parseArgs<Output>(
  arguments_: readonly string[],
  schema: OutputSchema<Output>,
): Promise<Output>;
async function parseArgs<Output>(
  arguments_: readonly string[],
  schema?: OutputSchema<Output>,
): Promise<Output | Record<string, unknown>> {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (normalized.length === 0 && schema !== undefined) {
    const emptyNamedResult = await schema["~standard"].validate({});
    if (emptyNamedResult.issues === undefined) {
      return emptyNamedResult.value;
    }
    if (emptyNamedResult.issues.every((issue) => issuePath(issue.path).length === 0)) {
      return await parsePositional(normalized, schema);
    }
  }
  const [first] = normalized;
  if (first !== undefined && !first.startsWith("--")) {
    if (schema === undefined) {
      throw new AgentInputError(`unexpected positional argument: ${first}`);
    }
    return await parsePositional(normalized, schema);
  }
  const pairs = pairsFromArguments(normalized);
  const candidate = assemble(pairs, true);
  if (schema === undefined) {
    return candidate;
  }
  return await uncoerceRejectedFields(schema, candidate, assemble(pairs, false), pairs.length);
}

function argsHelp(options: ArgsOptions): string {
  const [, scriptPath] = process.argv;
  const scriptName = basename(scriptPath ?? "script");
  const usage = options.usage ?? "[arguments]";
  const description = options.description === undefined ? "" : `${options.description}\n\n`;
  return `${description}Usage: ${scriptName} ${usage}\n`;
}

function exitWithArgsMessage(message: string, code: number, stream: NodeJS.WriteStream): never {
  stream.write(message);
  process.exit(code);
}

function isOutputSchema<Output>(
  value: OutputSchema<Output> | ArgsOptions | undefined,
): value is OutputSchema<Output> {
  return value !== undefined && "~standard" in value;
}

/** Parse `process.argv`, print standardized help/errors, and exit when no value can be returned. */
async function args(options?: ArgsOptions): Promise<Record<string, unknown>>;
async function args<Output>(schema: OutputSchema<Output>, options?: ArgsOptions): Promise<Output>;
async function args<Output>(
  schemaOrOptions?: OutputSchema<Output> | ArgsOptions,
  suppliedOptions: ArgsOptions = {},
): Promise<Output | Record<string, unknown>> {
  const schema = isOutputSchema(schemaOrOptions) ? schemaOrOptions : undefined;
  const options = isOutputSchema(schemaOrOptions) ? suppliedOptions : (schemaOrOptions ?? {});
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    return exitWithArgsMessage(argsHelp(options), 0, process.stdout);
  }
  try {
    return schema === undefined ? await parseArgs(arguments_) : await parseArgs(arguments_, schema);
  } catch (error) {
    if (error instanceof AgentInputError) {
      return exitWithArgsMessage(
        `unigent: ${error.message}\n\n${argsHelp(options)}`,
        1,
        process.stderr,
      );
    }
    throw error;
  }
}

export type { ArgsOptions, InputPair };
export { args, parseArgs };
