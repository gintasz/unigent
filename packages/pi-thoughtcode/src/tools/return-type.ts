import { type } from "arktype";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { extractReturnType, hasVibeFunction, listVibeFunctionReturnTypes } from "thoughtcode-core";

export type ReturnTypeCheck = { ok: true } | { ok: false; message: string };

export type ProgramSyntaxCheck = { ok: true } | { ok: false; errors: string[] };

export type ResolvedReturnType =
  | { status: "none" } // function has no return-type annotation
  | { status: "unreadable" } // program file could not be read
  | { status: "not-found" } // function is not declared in the program file
  | { status: "ok"; type: string } // valid annotation to enforce
  | { status: "invalid"; annotation: string }; // annotation present but not a recognized type

/**
 * Read the program file in code (not via the agent) and resolve the declared return type of a
 * VIBEFUNCTION. A present-but-unrecognized annotation is reported as `invalid` so the caller can fail
 * loudly — a bogus type is a program bug, not a reason to silently disable checking.
 */
export async function resolveReturnType(
  programFilePath: string,
  functionName: string,
  cwd: string | undefined,
): Promise<ResolvedReturnType> {
  let text: string;
  try {
    const absolute = isAbsolute(programFilePath) ? programFilePath : resolve(cwd ?? process.cwd(), programFilePath);
    text = await readFile(absolute, "utf8");
  } catch {
    return { status: "unreadable" };
  }
  if (!hasVibeFunction(text, functionName)) {
    return { status: "not-found" };
  }
  const annotation = extractReturnType(text, functionName);
  if (!annotation) {
    return { status: "none" };
  }
  if (!isParsableReturnType(annotation)) {
    return { status: "invalid", annotation };
  }
  return { status: "ok", type: annotation };
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

/**
 * Validate the syntax of a whole ThoughtCode program. Currently this means: every declared
 * VIBEFUNCTION return type must be a recognized ArkType expression. Untyped functions are allowed.
 * More checks will be added here over time.
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
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * Coerce a ThoughtCode return-type annotation into an ArkType definition. Structural types
 * (objects/records/tuples) are written as JSON and parse to a JS structure; scalar/expression types
 * (`number`, `number.integer`, `"ok" | "fail"`, `number > 0`, `string.email`, `number[]`) are bare
 * ArkType strings and fall through unchanged. No bespoke parser — JSON.parse plus ArkType.
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

/**
 * Validate a VIBERETURN value against a declared return-type annotation. A malformed annotation is
 * treated as "no constraint" (ok) rather than punishing the agent for the program author's mistake.
 */
export function checkReturnValue(rawValue: string, annotation: string): ReturnTypeCheck {
  let validator: (data: unknown) => unknown;
  try {
    validator = type(toArkDefinition(annotation) as never) as unknown as (data: unknown) => unknown;
  } catch {
    return { ok: true };
  }
  const out = validator(toValue(rawValue));
  if (out instanceof type.errors) {
    return { ok: false, message: out.summary };
  }
  return { ok: true };
}
