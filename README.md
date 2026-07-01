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

One coordination script, the whole surface — turn a one-line product idea into a
polished elevator pitch. It runs offline on a real model with nothing to mock:
every exposed method is pure local TypeScript, no network and no hypothetical APIs.
This is [`examples/pitch.ts`](examples/pitch.ts) verbatim — run it with
`microfoom run examples/pitch.ts "a budgeting app for freelancers"`.

```ts
import { writeFile } from "node:fs/promises";
import { FoomThrowError, foom, Program } from "@microfoom/core";
// The trace entry types `scope` / `annotate` / `log` / `usage` onto this.agent.
import "@microfoom/core/trace";
import { z } from "zod"; // any Standard Schema validator works

const WHITESPACE = /\s+/u;

// A bare Standard Schema is a valid program input — so the CLI's positional arg
// (`microfoom run pitch.ts "an app idea"`) lands straight in `main(idea)`.
const Idea = z.string().min(1);

const Pitch = z.object({
  headline: z.string(),
  body: z.string(),
  score: z.number().min(0).max(100),
});
type Pitch = z.infer<typeof Pitch>;

// Class scope of the config cascade (run-defaults → class → method → .with): a cheap
// model on the pi harness, FOOM-only (no harness tools — the program drives every
// side effect through @foom.expose), plus run-wide caps and a system-prompt append.
@foom.config({
  model: "openrouter/deepseek/deepseek-v4-flash",
  harness: "pi",
  thinking: "low",
  tools: [], // tri-state: [] = no harness tools; FOOM tools are always available
  retries: 1, // re-run a turn once on a transient harness/network failure
  maxConcurrentRootTurns: 4, // cap concurrent top-level turns; nested foom_calls exempt (tighten-only)
  maxBudgetUsd: 0.5, // whole-run cost ceiling; exceeding aborts
  systemPrompt: { append: "Be terse. Marketing copy, never code." },
})
export default class Pitchwright extends Program(Idea) {
  static maxProgramDuration = "3m"; // whole-program wall-clock ceiling

  async main(idea: string): Promise<Pitch> {
    // 1) Structured turn → schema-validated, typed value. The agent ends with
    //    foom_return; malformed output is auto-repaired. If the idea is unworkable
    //    it calls foom_throw instead — surfaced to your code as FoomThrowError.
    let angles: string[];
    try {
      angles = await this.agent.value(z.array(z.string()).max(4))`
        List up to 4 distinct angles to pitch a solution for this idea: ${idea}.
        If the idea is empty or incoherent, call foom_throw instead. foom_return the list.`;
    } catch (error) {
      if (error instanceof FoomThrowError) {
        throw new Error(`unworkable idea: ${error.message}`, { cause: error });
      }
      throw error;
    }

    // 2) A named trace scope: annotate it, fan child turns out in PARALLEL (plain
    //    TypeScript owns the control flow), each one foom_calling the exposed `rate`
    //    method (its own span nests under the scope), then log a line. The whole
    //    subtree shows up in the --tui inspector.
    const ranking = this.agent.scope("rank");
    ranking.annotate({ angleCount: angles.length });
    const scored = await Promise.all(
      angles.map(
        (angle, i) =>
          ranking
            .with({ label: `angle-${i}` })
            .value(z.object({ angle: z.string(), score: z.number() }))`
            Call rate on this angle to get a 0–100 punchiness score: ${angle}.
            foom_return { angle, score } using that score.`,
      ),
    );
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    ranking.log(`best angle scored ${best.score}`);

    // 3) Cross-session: open a STATEFUL session (shared transcript), seed it once,
    //    then fork() into two independent tonal branches that each continue from
    //    that shared context. Pick the better-scoring draft.
    const draft = this.agent.session({ thinking: "medium" });
    await draft.prose`We are drafting an elevator pitch for this angle: ${best.angle}. Reply "ready".`;
    const [punchy, formal] = await Promise.all([
      draft.fork().value(Pitch)`
        Write a PUNCHY two-line pitch (headline + body, each under 12 words — you may
        call wordCount to check). Call rate on the body and put that in "score". foom_return the Pitch.`,
      draft.fork().value(Pitch)`
        Write a FORMAL, credible two-line pitch. Call rate on the body and put that in
        "score". foom_return the Pitch.`,
    ]);
    const draftWinner = punchy.score >= formal.score ? punchy : formal;

    // 4) Best-of-N on a STRONGER model (cross-model). Two stateless samples of one
    //    prompt: distinct `storeKey`s keep them as separate store records under
    //    --store (otherwise identical turns collapse to one). Keep the better.
    //    Swap `model` for `harness: "claudecli"` here to route it CROSS-HARNESS
    //    (register that adapter — see "Run it" below).
    const polish = (key: string) =>
      this.agent
        .with({ model: "openrouter/deepseek/deepseek-v4-pro", thinking: "high", storeKey: key })
        .value(Pitch)`
          Tighten this pitch to its sharpest, most truthful form. Call rate on the new
          body and put that number in "score". foom_return the Pitch: ${JSON.stringify(draftWinner)}`;
    const samples = await Promise.all([polish("polish-a"), polish("polish-b")]);
    const winner = samples.reduce((a, b) => (b.score > a.score ? b : a));

    // 5) Act turn (`do`): side effects only, no response tokens billed. The agent
    //    persists the result through the `save` tool, then ends with a no-arg foom_return.
    await this.agent.do`Save the final pitch via the save tool: ${JSON.stringify(winner)}`;

    // 6) Read run usage and record it as a trace log — it shows in the --tui span
    //    tree / run panel (no stdout; `this.agent.usage` is a live snapshot).
    const { totalTokens, costUsd } = this.agent.usage;
    this.agent.scope("usage").log(`${totalTokens} tokens · $${(costUsd ?? 0).toFixed(4)}`);

    return winner;
  }

  // Silent expose: agent-callable via foom_call, but NOT advertised — the agent
  // only learns it exists when you name it in a prompt, then foom_inspects its
  // signature before calling. Pure, offline.
  @foom.expose
  async wordCount(text: string): Promise<number> {
    return text.trim().split(WHITESPACE).filter(Boolean).length;
  }

  // Announced expose: named in the system prompt so the agent knows it's there
  // (it still foom_inspects for the signature). A deterministic punchiness score.
  @foom.expose({ announcement: "Returns a 0–100 punchiness score for a line of copy." })
  async rate(text: string): Promise<number> {
    const words = await this.wordCount(text);
    return Math.max(0, Math.min(100, 120 - words * 6));
  }

  // Tool expose: a first-class native tool the harness advertises up front, with a
  // full parameter schema. Persists the result to disk.
  @foom.expose({ tool: { description: "Persist the final pitch as JSON to ./pitch.json." } })
  async save(pitch: Pitch): Promise<void> {
    await writeFile("./pitch.json", `${JSON.stringify(pitch, null, 2)}\n`);
  }
}
```

One script: structured `value` / freeform `prose` / side-effecting `do`; parallel
fan-out under a traced `scope` (with `annotate`/`log`); a stateful `session()` you
`fork()`; per-call cross-model routing; best-of-N with `storeKey`; all three
`@foom.expose` tiers; a `foom_throw` guard; and the config cascade with run-wide caps.
The pieces are unpacked in the sections below.

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


## Resuming work

A long run can be **killed and restarted without losing finished work**. Pass a store (`--store` on the CLI, or the `store` run option) and every completed turn is recorded by a content hash of its inputs; on a re-run, an unchanged turn is recalled from the store instead of re-invoking the model — you pay only for turns that haven't run yet.

- **`storeKey`** — ``.with({ storeKey: `draft-${i}` })`` forces an otherwise-identical turn to its own record, so best-of-N sampling of one prompt keeps N distinct results instead of collapsing to one.
- **`store: false`** — `.with({ store: false })` opts a turn out: always run fresh, never recalled.

Turns inside a stateful `session()` are not memoized — their shared transcript can't be reconstructed on recall.

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
| `maxConcurrentRootTurns` | Max concurrent **top-level** (depth-0) turns in one run — a work-in-progress limit, run-to-completion. Nested `foom_call` turns are part of their parent's work and don't count, so re-entry can never deadlock the cap. Tighten-only. |
| `maxTurnDuration` | Wall-clock ceiling for one turn (e.g. `"30s"`). Tighten-only. |

A whole-program wall-clock ceiling is a `static maxProgramDuration` on the program class (e.g. `"5m"`).

## Harnesses

A harness is the model-loop adapter a turn runs on.

| Harness | Status | Notes |
| --- | --- | --- |
| **pi** ([`@microfoom/pi-adapter`](packages/pi-adapter)) | recommended | Runs on the [Pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core) agent SDK; resolves model/auth from `~/.pi`. Full feature support. |
| **claudecli** ([`@microfoom/claudecli-adapter`](packages/claudecli-adapter)) | experimental | Drives the headless `claude` CLI (`claude -p`) via an in-process MCP server. |
| **codexcli** ([`@microfoom/codexcli-adapter`](packages/codexcli-adapter)) | experimental | Drives the headless `codex` CLI via an in-process MCP server. Ignores `maxBudgetUsd`, `omitBasePrompt`, `maxOutputTokens`, `plugins`, `allowedTools`; no token-level streaming. |
| **opencode** ([`@microfoom/opencode-adapter`](packages/opencode-adapter)) | experimental, not recommended | Runs on [opencode](https://github.com/anomalyco/opencode). Ignores `maxOutputTokens`; `plugins` needs more testing; no token-level streaming; barely tested — prefer pi. |

Register the harnesses you want under names, then select per scope via `@foom.config({ harness })` / `.with({ harness })`.


## Run it

The CLI runs a program file with zero boilerplate — model/auth resolved from the pi harness, the program result on stdout, observability on stderr.

```sh
<<<<<<< Updated upstream
microfoom run ./researcher.ts "tides"
microfoom run ./researcher.ts "tides" --json        # result as JSON
microfoom run ./researcher.ts "tides" --harness pi # 
microfoom run ./researcher.ts "tides" --store ./.microfoom/tides.jsonl  # store agent turn outcomes, re-run the same command to resume
=======
microfoom run examples/pitch.ts "a budgeting app for freelancers"
microfoom run examples/pitch.ts "a budgeting app" --json        # result as JSON
microfoom run examples/pitch.ts "a budgeting app" --store ./.microfoom/pitch.jsonl  # store turn outcomes; re-run to resume
microfoom run examples/audit.ts "acme.com" --harness fake        # offline, deterministic, no model (string-typed turns)
>>>>>>> Stashed changes
```

Add `--tui` to open a two-pane inspector: the live span tree on the left, the agent's transcript for the selected span on the right.

```sh
microfoom run examples/pitch.ts "a budgeting app" --tui
```

<div align="center">

<!-- Replace with a screenshot of `microfoom run … --tui`. -->
<img src="https://github.com/gintasz/microfoom/raw/main/assets/tui.png" alt="microfoom terminal UI" width="820" />

</div>

You can also run it programmatically.

```ts
import { createFileTurnStore, runProgram } from "@microfoom/core";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import { createClaudeCliOpenSession } from "@microfoom/claudecli-adapter";
import Pitchwright from "./examples/pitch.ts";

const pitch = await runProgram(Pitchwright, "a budgeting app for freelancers", {
  harnesses: {
    pi: createPiOpenSession(),
    // Registering claudecli lets the example's step 4 route cross-harness.
    claudecli: createClaudeCliOpenSession(),
  },
  defaultHarness: "pi",
  model: "openrouter/deepseek/deepseek-v4-flash",
  sourceFile: "./examples/pitch.ts", // required for foom_call parameter derivation
  store: createFileTurnStore("./.microfoom/pitch.jsonl"), // omit → nothing persisted
});
```

## License

[MIT](LICENSE) © Gintas Zenevskis
