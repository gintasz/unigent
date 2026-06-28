<div align="center">

<!-- Replace with your hero image (logo / banner). -->
<img src="./assets/hero.png" alt="microfoom" width="220" />

# microfoom

**Typed building blocks for agentic coordination engineering.**

Your code orchestrates. The model does only the fuzzy work.

[**Documentation**](https://gintasz.github.io/microfoom/)

</div>

---

microfoom is a TypeScript runtime for **coordination engineering** — composing many agents, sessions, and model harnesses into a single coordination script that a lone prompt or agent loop can't express.

## Coordination engineering

Two ideas lead here. **Loop engineering** — hand-rolling the run loop that drives an agent. And **dynamic workflows** — where a model writes a throwaway orchestration script for a single task and a runtime executes it, so the loop and intermediate results live in code instead of in the agent's context.

Both put real control flow around the model instead of trusting one prompt. Coordination engineering goes further. A **coordination script** is durable, typed TypeScript — kept, versioned, reused — that composes multiple agents, parallel sessions, and even **different model harnesses** into one program: coordination a single-harness dynamic workflow can't reach.

microfoom is the toolkit for writing coordination scripts.

- **Cross-harness, first-class** — compose agents running on different model harnesses in one script.
- **Small, clean API** — a handful of primitives; as easy to read as it is to write.
- **Traced out of the box** — every span, turn, and token is captured as a tree you can inspect, for the terminal UI or your own exporter.
- **Schema-validated** — structured turns return typed, validated values; malformed output is auto-repaired.

## Example

One program, most of the surface — a researcher that the model can only nudge, never hijack:

```ts
import { appendFile } from "node:fs/promises";
import { foom, Program } from "@microfoom/core";
import { z } from "zod"; // any Standard Schema validator works

const Input = z.object({ topic: z.string() });
type Input = z.infer<typeof Input>;

const Report = z.object({ summary: z.string(), confidence: z.number().min(0).max(1) });
type Report = z.infer<typeof Report>;

@foom.config({ model: "openrouter/deepseek/deepseek-v4-flash", thinking: "low", maxBudgetUsd: 0.5 })
export default class extends Program(Input) {
  async main({ topic }: Input): Promise<Report> {
    // A structured turn on the default ("fast") harness: split the topic up.
    const questions = await this.agent.value(z.array(z.string()).max(5))`
      List the key open questions about ${topic}. foom_return them.`;

    // Cross-harness: route the hard reasoning to a stronger "deep" harness, and
    // fan the questions out in parallel — ordinary TypeScript owns the control flow.
    const findings = await Promise.all(
      questions.map((q) =>
        this.agent
          .with({ harness: "deep", thinking: "high" })
          .prose`Answer concisely, calling headlines() if it helps: ${q}`),
    );

    // An act turn (`do`): the agent works through your tools and returns nothing —
    // you want the side effect, not a value.
    await this.agent.do`Save each finding with note(): ${findings.join("\n")}`;

    // Structured, schema-validated result — typed the moment you await it.
    return this.agent.value(Report)`
      Write a report on ${topic} from those findings, then foom_return it.`;
  }

  // Silent — callable, but the agent must foom_inspect to learn the signature.
  @foom.expose
  async note(text: string): Promise<void> {
    await appendFile("notes.md", `- ${text}\n`);
  }

  // Announced — the agent is told it exists, with no parameter schema upfront.
  @foom.expose({ announcement: "Fetch recent headlines for a query." })
  async headlines(query: string): Promise<string[]> {
    return (await fetch(`https://news.api/search?q=${query}`)).json();
  }
}
```

## The four control operations

An agent running inside a coordination script interacts with it through exactly **four** operations — native tools it is given, and nothing else.

- `foom_call(method, args)` — invoke one of your `@foom.expose`d methods.
- `foom_return(value)` — hand back the turn's result, validated against your schema.
- `foom_throw(message, code?)` — abort the turn with a deliberate error.
- `foom_inspect(method)` — look up an exposed method's parameter schema before calling it.

## Run it

Routing across harnesses means registering more than one, so launch the program with a tiny runner:

```ts
// run.ts
import { runProgram } from "@microfoom/core";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import Researcher from "./researcher.ts";

const report = await runProgram(Researcher, { topic: "tidal energy" }, {
  // Each harness can carry its own model, auth, tools, or runtime.
  harnesses: { fast: createPiOpenSession(), deep: createPiOpenSession() },
  defaultHarness: "fast",
  sourceFile: "./researcher.ts", // lets foom_inspect derive parameter schemas
});

console.log(report);
```

```sh
node --import tsx run.ts
```

A single-harness program needs no runner — run it straight from the CLI: `microfoom run ./program.ts '<input>'` (result → stdout, trace → stderr).

## Terminal UI

Add `--tui` to open a two-pane inspector: the live span tree on the left, the agent's transcript for the selected span on the right.

```sh
microfoom run ./researcher.ts --tui
```

<div align="center">

<!-- Replace with a screenshot of `microfoom run … --tui`. -->
<img src="./assets/tui.png" alt="microfoom terminal UI" width="820" />

</div>

## Documentation

Full guides and the API reference — generated from the source, the same docs your editor shows on hover — live at **[gintasz.github.io/microfoom](https://gintasz.github.io/microfoom/)**.
