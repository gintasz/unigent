import {
  buildVibeFunctionNotFoundMessage,
  collectVibeFunctionErrors,
  parseVibeCallArgs,
  serializeVibeCallArgs,
  type ParsedParam,
} from "thoughtcode-core";
import { bindAndCheckArgs } from "../runtime/params.js";
import { loadProgram } from "../runtime/program.js";

export type PreparedEntrypoint = { ok: true; args: string } | { ok: false; error: string };

/**
 * Resolve a /thoughtcode-run invocation: load the program, confirm the entrypoint exists, parse the
 * user-supplied args (bare single value / `name=value` pairs / JSON object), bind + type-check them,
 * and return the normalized `name=value` arg string for the subagent prompt. Validated up front so the
 * user gets an immediate error instead of a failed agent run.
 */
export async function prepareEntrypoint(
  programFilePath: string,
  functionName: string,
  rawArgs: string,
  cwd: string | undefined,
): Promise<PreparedEntrypoint> {
  const loaded = await loadProgram(programFilePath, cwd);
  if (!loaded.ok) {
    return { ok: false, error: `Cannot read program ${programFilePath}` };
  }
  const fn = loaded.program.functions.get(functionName);
  if (!fn) {
    return { ok: false, error: buildVibeFunctionNotFoundMessage(functionName, programFilePath) };
  }
  const declErrors = collectVibeFunctionErrors(fn);
  if (declErrors.length > 0) {
    return { ok: false, error: `VIBEFUNCTION \`${functionName}\`: ${declErrors.join("; ")}` };
  }

  const values = parseEntrypointArgs(rawArgs.trim(), functionName, fn.params);
  if ("error" in values) {
    return { ok: false, error: values.error };
  }
  const binding = bindAndCheckArgs(fn.params, values.values);
  if (!binding.ok) {
    return { ok: false, error: binding.error };
  }
  return { ok: true, args: serializeVibeCallArgs(binding.bound) };
}

function parseEntrypointArgs(
  raw: string,
  functionName: string,
  params: ParsedParam[],
): { values: Record<string, unknown> } | { error: string } {
  if (raw === "") {
    return { values: {} };
  }
  if (raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: `Invalid JSON arguments: ${raw}` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "JSON arguments must be an object of name/value pairs" };
    }
    return { values: parsed as Record<string, unknown> };
  }
  if (raw.includes("=")) {
    const parsed = parseVibeCallArgs(raw);
    if (parsed.errors.length > 0) {
      return { error: parsed.errors.join("; ") };
    }
    return { values: parsed.values };
  }
  // Bare single value bound to the sole parameter.
  if (params.length === 0) {
    return { error: `\`${functionName}\` takes no arguments` };
  }
  if (params.length > 1) {
    return {
      error: `\`${functionName}\` takes ${params.length} arguments — pass them as name=value pairs or a JSON object`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw; // not valid JSON → treat as a plain string
  }
  return { values: { [params[0].name]: value } };
}
