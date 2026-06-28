# microfoom
Typed building blocks for agentic **coordination engineering**.


A TypeScript runtime where **your code orchestrates and the model does only the
fuzzy work**. You write ordinary TypeScript — control flow, recursion, parallelism,
arithmetic — and call the agent for the genuinely non-deterministic parts. The
agent affects your program only through four structured control tools, never by
string-matching its prose.

```ts
import { foom, Program } from "@microfoom/core";
import { z } from "zod"; // any Standard Schema validator

const Input = z.object({ topic: z.string() });

@foom.config({ model: "openrouter/deepseek/deepseek-v4-flash", thinking: "medium" })
export default class extends Program<typeof Input, number>(Input) {
  async main(input: typeof Input._type): Promise<number> {
    // Prose channel — conversational text.
    await this.agent.text`Briefly explain ${input.topic}.`;

    // Structured channel — schema-validated value via `foom_return`.
    return await this.agent.value(z.number().int())`
      Pick a number between 0 and 100. `foom_return` it.
    `;
  }

  // Methods are unreachable by the agent until @foom.expose (capability security).
  @foom.expose({ announcement: "Generates a random integer in [min, max]." })
  async randomInt(min: number, max: number): Promise<number> {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
```

## The 4 control operations (agent tools)

The agent, invoked via microfoom, communicates with your program only through function-calling:

- **`foom_call(method_name, args_object)`** — invoke an exposed method in microfoom program.
- **`foom_return(args_object)`** — return a structured value.
- **`foom_throw(message, code)`** — abort execution with an error.
- **`foom_inspect(method_name)`** — read an exposed method's parameter schema.

Exposed methods come in three tiers by context cost: silent (`@foom.expose`),
announced (`{ announcement }`), and full native tool (`{ tool }`, parameters
derived from the TypeScript signature).

## Running a program

**Via the CLI** (the agent runs this over bash; result → stdout, trace → stderr):

```
microfoom run ./my-program.ts [input]
```

**Programmatically:**

```ts
import { runProgram } from "@microfoom/core";
import { createPiOpenSession } from "@microfoom/pi-adapter";

const result = await runProgram(MyProgram, input, {
  harnesses: { pi: createPiOpenSession() }, // named harness ports; sole entry is the default
  model: "openrouter/deepseek/deepseek-v4-flash",
  sourceFile: "./my-program.ts", // enables `foom_call` parameter derivation
});
// Multiple harnesses in one program: register several and select per agent via
// `.with({ harness })` / `@foom.config({ harness })`; set `defaultHarness` for the
// widest scope when there is more than one.
```

## Development

```bash
pnpm install
pnpm run check     # the full gate: typecheck, lint, arch, ast, spell, deps, dead, dup, build, test
pnpm test          # deterministic suite (excludes e2e)
pnpm run test:e2e  # real-LLM diagnostics (needs model auth in ~/.pi; skips otherwise)
```

Repo-level decisions live in [`CONSTITUTION.md`](./CONSTITUTION.md); significant
choices are recorded as ADRs in [`docs/adr`](./docs/adr). The full consumer-facing
