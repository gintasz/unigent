# microfoom

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

    // Structured channel — schema-validated value via FOOMRETURN.
    return await this.agent.value(z.number().int())`
      Pick a number between 0 and 100. FOOMRETURN it.
    `;
  }

  // Methods are unreachable by the agent until @foom.expose (capability security).
  @foom.expose({ announcement: "Generates a random integer in [min, max]." })
  async randomInt(min: number, max: number): Promise<number> {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
```

## The four control operations (FOOM\*)

The agent reaches your program only through native function-calling, never parsed
from text:

- **FOOMCALL** — invoke an exposed method.
- **FOOMRETURN** — return a structured value (validated against a Standard Schema).
- **FOOMTHROW** — abort with a caller-defined error code.
- **FOOMINSPECT** — read an exposed method's parameter schema.

Exposed methods come in three tiers by context cost: silent (`@foom.expose`),
announced (`{ announcement }`), and full native tool (`{ tool }`, parameters
derived from the TypeScript signature).

## Packages

| Package | Role |
| --- | --- |
| `@microfoom/core` | Harness-agnostic runtime: program model, `@foom` decorators, config cascade, schema derivation, FOOM tool semantics, error taxonomy. Effect-free public surface. |
| `@microfoom/pi-adapter` | The reference harness adapter over the [pi](https://github.com/earendil-works/pi) agent: binds core's session port to pi's runtime so programs run against a real model. |
| `@microfoom/cli` | The `microfoom run` CLI: run a program file, result to stdout, live trace panel to stderr. |

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
  openSession: createPiOpenSession(), // resolves model + auth from ~/.pi
  model: "openrouter/deepseek/deepseek-v4-flash",
  sourceFile: "./my-program.ts", // enables FOOMCALL parameter derivation
});
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
API design is sketched in [`docs/design/api-sketch.ts`](./docs/design/api-sketch.ts).
