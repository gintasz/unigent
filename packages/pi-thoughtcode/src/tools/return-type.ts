import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { extractReturnType, hasVibeFunction, isParsableReturnType } from "thoughtcode-core";

// The type system + program validation now live in thoughtcode-core (pure, ArkType-only). This module
// keeps only the file-reading resolver and re-exports the pure helpers for back-compat.
export {
  checkReturnValue,
  isParsableReturnType,
  validateProgramSyntax,
  validateValue,
  type ProgramSyntaxCheck,
  type ReturnTypeCheck,
} from "thoughtcode-core";

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
