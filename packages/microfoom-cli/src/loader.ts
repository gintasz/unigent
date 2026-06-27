// Load a microfoom program (its default export) from a source file. `node` has no
// TS loader, so register tsx once (transpiles TS + `@foom` decorators on the fly),
// globally, so the program and its `@microfoom/core` import share ONE module graph
// with this process (a scoped loader would duplicate core and break the
// program→agent binding). Same approach as the pi extension.

import { pathToFileURL } from "node:url";
import type { FoomtimeProgram } from "@microfoom/core";
import { register } from "tsx/esm/api";

export type ProgramClass = abstract new () => FoomtimeProgram<never, unknown>;

let registered = false;

/** Import `sourceFile` and return its default-exported program class. */
export async function loadProgram(sourceFile: string): Promise<ProgramClass> {
  if (!registered) {
    register();
    registered = true;
  }
  const moduleExports = (await import(pathToFileURL(sourceFile).href)) as { default?: unknown };
  const program = moduleExports.default;
  if (typeof program !== "function") {
    throw new TypeError(`${sourceFile} has no default-exported program`);
  }
  return program as ProgramClass;
}
