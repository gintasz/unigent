// Whole-program syntax validation: return types, param types, defaults, and decorators must all be
// well-formed. Untyped functions/params are allowed. Pure — no file IO.

import { buildVibeRunConfig } from "./decorators.js";
import { parseProgram, type VibeFunction } from "./parser.js";
import { isParsableReturnType } from "./types.js";

export type ProgramSyntaxCheck = { ok: true } | { ok: false; errors: string[] };

/**
 * Canonical per-function declaration check: every well-formedness rule for a VIBEFUNCTION header
 * (return type, decorators, param declarations + types) lives here, returned as bare messages.
 * Callers add their own framing — see {@link validateProgramSyntax} and the VIBECALL pre-flight.
 */
export function collectVibeFunctionErrors(fn: VibeFunction): string[] {
  const errors: string[] = [];
  if (fn.returnType && !isParsableReturnType(fn.returnType)) {
    errors.push(
      `declares an unrecognized return type \`${fn.returnType}\`. ` +
        `Use a valid ArkType expression — e.g. number, number.integer, string, boolean, "number > 0", or '"ok" | "fail"'.`,
    );
  }
  errors.push(...fn.decoratorErrors, ...buildVibeRunConfig(fn.decorators).errors, ...fn.paramErrors);
  for (const param of fn.params) {
    if (param.type && !isParsableReturnType(param.type)) {
      errors.push(`parameter \`${param.name}\` declares an unrecognized type \`${param.type}\`.`);
    }
  }
  return errors;
}

export function validateProgramSyntax(programText: string): ProgramSyntaxCheck {
  const errors: string[] = [];
  for (const fn of parseProgram(programText).functions.values()) {
    for (const error of collectVibeFunctionErrors(fn)) {
      errors.push(`VIBEFUNCTION \`${fn.name}\`: ${error}`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
