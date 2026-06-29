<div align="center">

<!-- Replace with your hero image (logo / banner). -->
<img src="https://github.com/gintasz/microfoom/raw/main/assets/diagram.png" alt="coordination engineering" width="640" />

# microfoom

**Typed building blocks for agentic coordination engineering.**

[**Documentation**](https://gintasz.github.io/microfoom/) [**Examples**](https://github.com/gintasz/microfoom/tree/main/examples)

</div>

---

Microfoom is a TypeScript framework for **coordination engineering** — composing many agents, sessions, and model harnesses into a single coordination script that a lone prompt or agent loop can't express.

## Coordination engineering

Two ideas lead here. **Loop engineering** — hand-rolling the run loop that drives an agent. And **dynamic workflows** — where a model writes a throwaway orchestration script for a single task and a runtime executes it, so the loop and intermediate results live in code instead of in the agent's context.

Both put real control flow around the model instead of trusting one prompt. Coordination engineering goes further. A **coordination script** is durable, typed TypeScript — kept, versioned, reused — that composes multiple agents, parallel sessions, and even **different model harnesses** into one program: coordination a single-harness dynamic workflow can't reach.

Microfoom is the toolkit for writing coordination scripts.

- **Cross-harness** — compose agents running on different model harnesses in one script.
- **Cross-session** — run parallel sessions, and `fork()` any one to branch its transcript, all coordinated in a single script.
- **Cross-model** — route each turn to a different model: cheap for the easy steps, frontier for the hard one.
- **Lean & ergonomic API** — a handful of primitives; as easy to read as it is to write.
- **Schema-validated** — structured turns return typed, validated values; malformed output is auto-repaired, then fails loudly.
- **Traced out of the box** — every span, turn, and token is captured as a tree you can inspect, for the terminal UI or your own exporter.

## Install

Requires **Node ≥ 24**.

```sh
# Library + harness adapter (see available adapters below)
npm install @microfoom/core @microfoom/pi-adapter

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

Inside `main()`, `this.agent` is your handle to the runtime — how your program drives the runtime that runs agents. Every call on it is one **turn**: you hand off an instruction and a new harness agent works on it — reasoning and calling tools as it goes — until it hands a result back to your code. Each turn resolves as a normal `await`, so a coordination script reads as ordinary TypeScript, not callbacks. You choose a *mode* by what you want back:

- **`value(schema)`** — a structured turn. The agent ends its work by calling the `foom_return` tool with a value, which is validated against the schema you passed; the awaited result is typed. If it doesn't, a repair prompt nudges it to make that call — or to use `foom_throw` as a last resort when the instructions can't be satisfied (impossible, self-contradictory, etc.).
- **`prose`** — a freeform natural-language turn: the ordinary case of the agent answering your prompt. Its reply *is* the return value — `await` for the full text.
- **`do`** — an act turn: run instructions for their side effects and resolve to `void`. The cheapest mode — no schema, no final message. The agent is told to finish with a no-argument `foom_return`, which cuts the unnecessary yapping you'd otherwise pay for (the "I've successfully completed your request… let me know if you need anything else!" tail).


## Tracing

A **run** is one execution of your program — a single `runProgram(...)` (or `microfoom run …`), from `main()` to the value it returns. Microfoom records each run as a tree of **spans**, where a span is one named, timed unit of work: the run at the root, the turns it runs beneath it, and any exposed method the agent calls mid-turn nested inside that turn. Each span carries its duration and its token/cost usage, and that usage rolls up into its parent — so any span totals everything beneath it. Importing the trace entry lets you name your own spans and read the tree out:

```ts
import "@microfoom/core/trace";
```

- **`this.agent.scope("name")`** — open a **scope**: a manual span that groups related turns (which otherwise sit flat under `main`). Scopes nest, so the tree mirrors the shape of the task.
- **`scope.annotate({ … })`** — attach structured key/values to that span (a route, an id, a count), so you can see which inputs led to which work.
- **`scope.log(message, level?)`** — attach a message to that span. It lives on the span and shows next to it in the inspector, not in the stdout.
- **`this.agent.onEvent(handler)` / `.export(exporter)`** — read the event stream yourself, or pipe it out to a custom exporter.

The CLI's run panel and `--tui` inspector render exactly this tree.


## How the agent talks to your program

An agent running inside a microfoom runtime interacts with it through 4 native tools — surfaced as structured function calls.

- `foom_return(value)` — hand back the turn's result, validated against your schema.
- `foom_call(method_name, args)` — invoke one of your `@foom.expose`d methods.
- `foom_throw(message, code?)` — abort the turn with a deliberate, typed error.
- `foom_inspect(method_name)` — look up an exposed method's parameter schema before calling it.

Other than these 4 tools and a few extra lines added to its system prompt, an agent spawned by a coordination script is no different from one spawned by a CLI, because it uses the same default configuration of the harness.

## Configuration

Set config with `@foom.config({ ... })` on a class or method, with `.with({ ... })` per call, or as run-level defaults. Scopes cascade widest → narrowest (**run defaults → class → method → per-call**), merging by a rule fixed per option kind: **caps tighten only**, **`systemPrompt` composes**, **everything else is nearest-scope-wins**.

| Option | Meaning |
| --- | --- |
| `model` | Model id as `"provider/id"`. Opaque to the core; the harness resolves it. Required somewhere in the cascade. |
| `harness` | Which registered harness runs the turn. Required somewhere in the cascade. |
| `thinking` | Reasoning effort: `"low"` / `"medium"` / `"high"`, or a provider-specific raw string. |
| `tools` | Harness tools the model may use (tri-state: `undefined` = all, `[]` = none, list = only those). FOOM tools are always available. |
| `skills`  | Which of the harness's installed agent skills to offer the model this scope (same tri-state as `tools`, by skill name). |
| `plugins` | Which of the harness's extensions to load this scope (same tri-state, by source name). |
| `retries` | Re-run a turn on a *transient* harness failure — provider/network error, model overloaded, no result produced. Default `0`. A deliberate `foom_throw` or a bad-config rejection is never retried; schema-validation failures use `repairAttempts`. |
| `repairAttempts` | Validation failures tolerated before giving up (default `3`). |
| `systemPrompt` | This scope's contribution: `{ append }` accumulates, `{ replace }` resets the base. |
| `omitHarnessBasePrompt` | Drop the harness's own base prompt (its coding persona / project context), sending the model only microfoom's prompt + custom `systemPrompt`. |
| `maxBudgetUsd` | Cost ceiling; exceeding aborts. Tighten-only. |
| `maxOutputTokens` | Output-token ceiling. Tighten-only. |
| `maxCallDepth` | Max `foom_call` re-entry depth. Tighten-only. |
| `maxConcurrentTurns` | Max concurrent model turns in one run. Tighten-only. FOOM tool handlers do not consume a slot, so nested `foom_call` re-entry cannot deadlock a single-slot run. |
| `maxTurnDuration` | Wall-clock ceiling for one turn (e.g. `"30s"`). Tighten-only. |

A whole-program wall-clock ceiling is a `static maxProgramDuration` on the program class (e.g. `"5m"`).

## Harnesses

A harness is the model-loop adapter a turn runs on. Microfoom ships two:

- **pi** ([`@microfoom/pi-adapter`](packages/pi-adapter)) — runs on the [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core) agent SDK; resolves model/auth from `~/.pi`.
- **claudecli** ([`@microfoom/claudecli-adapter`](packages/claudecli-adapter)) — drives the headless `claude` CLI (`claude -p`) via an in-process MCP server.
- **codexcli** ([`@microfoom/codexcli-adapter`](packages/codexcli-adapter)) — drives the headless `codex` CLI via an in-process MCP server. Note: `maxBudgetUsd`, `omitBasePrompt`, `maxOutputTokens`, `plugins`, `allowedTools` — ignored, no effect. Also, no token-level streaming (live TUI = chunky for codex).

Register the harnesses you want under names, then select per scope via `@foom.config({ harness })` / `.with({ harness })`:


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

You can also run it programmatically.

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

## License

[MIT](LICENSE) © Gintas Zenevskis
