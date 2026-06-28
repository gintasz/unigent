<div align="center">

<!-- Replace with your hero image (logo / banner). -->
<img src="https://github.com/gintasz/microfoom/raw/main/assets/diagram.png" alt="coordination engineering" width="640" />

# microfoom

**Typed building blocks for agentic coordination engineering.**

[**Documentation**](https://gintasz.github.io/microfoom/)

</div>

---

Microfoom is a TypeScript runtime for **coordination engineering** — composing many agents, sessions, and model harnesses into a single coordination script that a lone prompt or agent loop can't express.

## Coordination engineering

Two ideas lead here. **Loop engineering** — hand-rolling the run loop that drives an agent. And **dynamic workflows** — where a model writes a throwaway orchestration script for a single task and a runtime executes it, so the loop and intermediate results live in code instead of in the agent's context.

Both put real control flow around the model instead of trusting one prompt. Coordination engineering goes further. A **coordination script** is durable, typed TypeScript — kept, versioned, reused — that composes multiple agents, parallel sessions, and even **different model harnesses** into one program: coordination a single-harness dynamic workflow can't reach.

Microfoom is the toolkit for writing coordination scripts.

- **Cross-harness** — compose agents running on different model harnesses in one script.
- **Lean & ergonomic API** — a handful of primitives; as easy to read as it is to write.
- **Schema-validated** — structured turns return typed, validated values; malformed output is auto-repaired, then fails loudly.
- **Traced out of the box** — every span, turn, and token is captured as a tree you can inspect, for the terminal UI or your own exporter.

## Install

Requires **Node ≥ 24**.

```sh
# Library + harness adapters
npm install @microfoom/core @microfoom/pi-adapter @microfoom/claudecli-adapter

# The CLI runner — provides the `microfoom` command
npm install -g @microfoom/cli
```

## Example

```ts
import { appendFile } from "node:fs/promises";
import { foom, Program } from "@microfoom/core";
import { z } from "zod"; // any Standard Schema validator works

const Input = z.object({ topic: z.string() });
type Input = z.infer<typeof Input>;

const Report = z.object({ summary: z.string(), confidence: z.number().min(0).max(1) });
type Report = z.infer<typeof Report>;

@foom.config({ model: "openrouter/deepseek/deepseek-v4-flash", harness: "pi", thinking: "low" })
export default class extends Program(Input) {
  async main({ topic }: Input): Promise<Report> {
    // A structured turn on the default harness: split the topic up.
    const questions = await this.agent.value(z.array(z.string()).max(5))`
      List 5 key open questions about ${topic}. Provide them via foom_return tool.`;

    // Cross-harness: route the hard reasoning to a stronger harness (or model), and
    // fan the questions out in parallel — ordinary TypeScript owns the control flow.
    const findings = await Promise.all(
      questions.map((q) =>
        this.agent
          .with({ harness: "claudecli", model: "sonnet", thinking: "high" })
          .prose`Answer concisely, call "headlines" method via foom_call tool if it helps: ${q}`),
    );

    // An act turn (`do`): run instructions for their side effects, return nothing —
    // no tokens wasted on a response you don't read. The agent is told to call
    // foom_return with no arguments once the work is done.
    await this.agent.do`Save each finding with the "note" method via foom_call tool: ${findings.join("\n")}`;

    // Structured, schema-validated result — typed the moment you await it.
    return this.agent.value(Report)`
      Write a report on ${topic} from those findings, then provide it via foom_return tool.`;
  }

  // Silent expose: callable via foom_call, but the agent doesn't know it exists
  // until you name it in your prompt. It must foom_inspect to learn the argument signature before calling.
  @foom.expose
  async note(text: string): Promise<void> {
    await appendFile("notes.md", `- ${text}\n`);
  }

  // Announced expose: the agent is told the method exists in its system prompt.
  // It must foom_inspect to learn the argument signature before calling.
  @foom.expose({ announcement: "Fetch recent headlines for a query." })
  async headlines(query: string): Promise<string[]> {
    return (await fetch(`https://news.api/search?q=${query}`)).json();
  }

  // Tool expose: registers as a first-class agent tool inside the harness.
  @foom.expose({ tool: { description: "Search the web for a query." } })
  async searchWeb(query: string): Promise<string[]> {
    return (await fetch(`https://search.api/q?query=${query}`)).json();
  }
}
```

## Turn modes

`this.agent` drives the model through three modes:

- **`value(schema)`** — a structured turn. The agent must `foom_return` a value, validated against your Standard Schema; the awaited result is typed.
- **`prose`** — a freeform natural-language turn. `await` for the full text, or `for await` to stream chunks.
- **`do`** — an act turn: run instructions for their side effects and resolve to `void`. The cheapest mode — no schema, no final message.

`.with({ ... })` layers per-call config; `.session()` opens a stateful conversation (shared transcript, `.fork()` to branch); `.scope("name")` (via `@microfoom/core/trace`) groups turns in the trace tree.

## Control operations given to the agent

An agent running inside a microfoom runtime interacts with it through 4 native tools — surfaced as structured function calls.

- `foom_return(value)` — hand back the turn's result, validated against your schema.
- `foom_call(method_name, args)` — invoke one of your `@foom.expose`d methods.
- `foom_throw(message, code?)` — abort the turn with a deliberate, typed error.
- `foom_inspect(method_name)` — look up an exposed method's parameter schema before calling it.

Other than these 4 tools and a few lines added to its system prompt, an agent spawned by a coordination script is no different from one spawned by a CLI, because it uses the same default configuration.

## Configuration

Set config with `@foom.config({ ... })` on a class or method, with `.with({ ... })` per call, or as run-level defaults. Scopes cascade widest → narrowest (**run defaults → class → method → per-call**), merging by a rule fixed per option kind: **caps tighten only**, **`systemPrompt` composes**, **everything else is nearest-scope-wins**.

| Option | Meaning |
| --- | --- |
| `model` | Model id as `"provider/id"`. Opaque to the core; the harness resolves it. Required somewhere in the cascade. |
| `harness` | Which registered harness runs the turn. Required somewhere in the cascade. |
| `thinking` | Reasoning effort: `"low"` / `"medium"` / `"high"`, or a provider-specific raw string. |
| `tools` | Harness tools the model may use (tri-state: `undefined` = all, `[]` = none, list = only those). FOOM tools are always available. |
| `skills` | Skills the harness advertises (tri-state). pi only. |
| `plugins` | Plugins/extensions the harness loads (tri-state). pi only. |
| `retries` | Retries on a *retryable* harness error. |
| `repairAttempts` | Validation failures tolerated before giving up (default `3`). |
| `systemPrompt` | This scope's contribution: `{ append }` accumulates, `{ replace }` resets the base. |
| `maxBudgetUsd` | Cost ceiling; exceeding aborts. Tighten-only. |
| `maxOutputTokens` | Output-token ceiling. Tighten-only. |
| `maxCallDepth` | Max `foom_call` re-entry depth. Tighten-only. |
| `maxTurnDuration` | Wall-clock ceiling for one turn (e.g. `"30s"`). Tighten-only. |

A whole-program wall-clock ceiling is a `static maxProgramDuration` on the program class (e.g. `"5m"`).

## Harnesses

A harness is the model-loop adapter a turn runs on. Microfoom ships two:

- **pi** ([`@microfoom/pi-adapter`](packages/pi-adapter)) — runs on the [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core) agent SDK; resolves model/auth from `~/.pi`, and supports skills, plugins, and session `fork()`.
- **claudecli** ([`@microfoom/claudecli-adapter`](packages/claudecli-adapter)) — drives the headless `claude` CLI (`claude -p`) via an in-process MCP server.

Register the harnesses you want under names, then select per scope via `@foom.config({ harness })` / `.with({ harness })`:

```ts
import { runProgram } from "@microfoom/core";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import { createClaudeCliOpenSession } from "@microfoom/claudecli-adapter";

const report = await runProgram(MyProgram, { topic: "tides" }, {
  harnesses: {
    pi: createPiOpenSession(),
    claudecli: createClaudeCliOpenSession(),
  },
  defaultHarness: "pi",
  model: "openrouter/deepseek/deepseek-v4-flash",
  sourceFile: "./my-program.ts", // required for foom_call parameter derivation
});
```

## Run it

The CLI runs a program file with zero boilerplate — model/auth resolved from the pi harness, the program result on stdout, observability on stderr.

```sh
microfoom run ./researcher.ts "tides"
microfoom run ./researcher.ts "tides" --json        # result as JSON
microfoom run ./researcher.ts "tides" --harness fake # offline, deterministic, no model
```

Add `--tui` to open a two-pane inspector: the live span tree on the left, the agent's transcript for the selected span on the right.

```sh
microfoom run ./researcher.ts --tui
```

<div align="center">

<!-- Replace with a screenshot of `microfoom run … --tui`. -->
<img src="https://github.com/gintasz/microfoom/raw/main/assets/tui.png" alt="microfoom terminal UI" width="820" />

</div>

You can also run programs programmatically — see [examples/run.ts](examples/run.ts) and the other [examples](examples).

## License

[MIT](LICENSE) © Gintas Zenevskis
