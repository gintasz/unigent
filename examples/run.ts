// Programmatic runner for the hello example. Resolves model + API key from ~/.pi
// via the pi harness, then runs the program and prints its result.

import { runProgram } from "@microfoom/core";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import Hello from "./hello.ts";

const who = process.argv[2] ?? "world";
const model = process.env.MICROFOOM_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";

const result = await runProgram(Hello, who, {
  openSession: createPiOpenSession(),
  model,
});

console.log(result);
