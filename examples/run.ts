// Programmatic runner for any example. Resolves model + API key from ~/.pi via the
// pi harness, imports the program file's default export, runs it, prints the result.
//
//   node --import tsx examples/run.ts examples/hello.ts world   # program + input
//   node --import tsx examples/run.ts examples/audit.ts acme.com
//
// A program with no input (e.g. `Program(z.void())`) takes no second argument.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runProgram } from "@microfoom/core";
import { createPiOpenSession } from "@microfoom/pi-adapter";

const [fileArg, inputArg] = process.argv.slice(2);
if (fileArg === undefined) {
  console.error("usage: run.ts <program-file> [input]");
  process.exit(1);
}

// Resolve the program path against the working directory (absolute paths pass
// through). Input is whatever was given; absent input is left undefined so the
// program's own schema decides (a no-input program needs none).
const sourceFile = resolve(process.cwd(), fileArg);
const input = inputArg;

const module_ = (await import(pathToFileURL(sourceFile).href)) as { default?: unknown };
const ProgramClass = module_.default;
if (typeof ProgramClass !== "function") {
  console.error(`${sourceFile}: no default-exported program`);
  process.exit(1);
}

const model = process.env.MICROFOOM_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";
const result = await runProgram(ProgramClass as never, input, {
  harnesses: { pi: createPiOpenSession() },
  model,
  sourceFile, // enables foom_call parameter derivation (ADR-0003)
});

console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
