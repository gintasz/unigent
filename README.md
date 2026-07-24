<p align="center">
  <img src="https://github.com/gintasz/unigent/raw/refs/heads/main/assets/icon.svg" alt="Unigent" width="96" height="96" />
</p>

<h1 align="center">Unigent</h1>

<p align="center"><strong>The cross-harness agent SDK for TypeScript.</strong></p>

<p align="center">
  Build stateful agent workflows with typed outputs, reusable tools, session forks, and ordinary TypeScript.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/unigent-sdk"><img alt="npm version" src="https://img.shields.io/npm/v/unigent-sdk?logo=npm&logoColor=white" /></a>
  <a href="https://github.com/gintasz/unigent/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0A7EA4" /></a>
  <a href="https://github.com/gintasz/unigent/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/gintasz/unigent?style=flat" /></a>
  <img alt="Works with" src="https://img.shields.io/badge/works_with-555555" />
  <a href="https://github.com/earendil-works/pi"><img alt="Pi SDK" src="https://img.shields.io/badge/Pi_SDK-7AA2F7" /></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code"><img alt="Claude CLI" src="https://img.shields.io/badge/Claude_Code-E5582B" /></a>
  <a href="https://developers.openai.com/codex/cli/"><img alt="Codex CLI" src="https://img.shields.io/badge/Codex_CLI-10A37F" /></a>
</p>

<p align="center"><a href="https://github.com/gintasz/unigent/tree/main/examples">Examples</a></p>

---

## Why Unigent?

The agent CLIs you already have installed — Pi, Claude Code, Codex — are powerful, but each has its
own API, its own session model, and no way to get a typed value back. Unigent puts one TypeScript
surface over all of them.

- **🔀 One API, every harness.** Write your workflow once against Pi, Claude Code, or Codex CLI.
  Swap the backend with a one-line change; the agent, tools, sessions, and structured outputs stay
  the same.
- **🧠 Deterministic host, fuzzy agent.** Orchestration — control flow, branching, parallelism,
  recursion — lives in your TypeScript, where it is testable and reviewable. The model is invoked
  only for genuinely fuzzy work: judgment and language.
- **📦 Typed structured outputs, never scraped from prose.** Ask a run for a [Zod](https://zod.dev/) (or any
  [Standard Schema](https://standardschema.dev/)) value and get back the inferred TypeScript type
  through a reserved completion tool. Markdown preambles and trailing commentary cannot corrupt
  the value.
- **🧩 Agents are ordinary functions.** A tool is a named function; a nested agent is a function
  that calls `.run()`. Composition, error handling, and testing are plain `async`/`await` and
  `try`/`catch` — no new runtime to learn.
- **🌳 Built for real workflows.** Sessions keep conversation context, forks branch it in parallel,
  scopes group runs with budgets and deadlines, and checkpoints reuse finished work across reruns.
- **🔍 See everything that happened.** Every run returns a full trace — nested runs, tool calls,
  prompts, usage, cost — and the `unigent tui` inspector renders the live run tree as it happens.

---

## Quickstart

> **Prerequisites:** Node.js **24 or newer**, plus at least one authenticated harness:
> [Pi](https://github.com/earendil-works/pi) configured locally, or the official Claude Code /
> Codex CLIs installed and signed in. The live trace inspector (`unigent tui`) additionally
> requires [Bun](https://bun.sh/). Published packages are ESM-only.

```bash
npm install unigent-sdk zod
npm install -g unigent-cli
```

Write your first agent:

```typescript
import { agent, piAgent } from "unigent-sdk";

const writer = agent({
  name: "writer",
  backend: piAgent(),
  model: "openrouter/deepseek/deepseek-v4-flash",
});

const result = await writer.run("Write one sentence about durable software.");
console.log(result.output);
```

`result` also contains token usage, any cost reported by the harness, and the full trace. The run
starts immediately, can be aborted, and exposes its events as an async iterable while you await the
final result.

Run it through the CLI to get live traces:

```bash
unigent your-script.ts "your prompt"
unigent tui your-script.ts "your prompt"   # live trace inspector
```

See [`examples/hello.ts`](https://github.com/gintasz/unigent/blob/main/examples/hello.ts) for the
smallest complete script and
[`examples/pitch.ts`](https://github.com/gintasz/unigent/blob/main/examples/pitch.ts) for a
workflow using most of the API.

---

## The mental model

Unigent is a small set of building blocks. Everything else on this page is detail about one of
them.

```
  agent ──▶ run(prompt [, schema]) ──▶ result { output, usage, trace }
    │            ▲
    │            └── prose · Standard Schema value · done · fail
    ├── backend: piAgent() · claudeCli() · codexCli()  (the harness adapter)
    ├── tools: [yourFunction]        (opt-in; nothing callable unless listed)
    ├── session() ──▶ fork()         (keep context, branch it in parallel)
    ├── scope(name)                  (group runs: usage, traces, budget, deadline)
    └── checkpoint                   (reuse finished runs across reruns)
```

- **Agent** — a named, configured worker: a backend (harness adapter), a model, and optional
  tools, system prompt, and limits.
- **Run** — one prompt through the harness. Stateless by default; returns prose, a typed
  structured value, or `void` for side-effect work (`done`).
- **Tool** — an ordinary TypeScript function the agent may call. Only functions listed in `tools`
  are callable — capability security, nothing is exposed by default.
- **Session & fork** — a session keeps the harness conversation for later turns; a fork branches
  it so parallel reviewers reuse gathered context instead of paying to rebuild it.
- **Scope** — a named workflow boundary owning cumulative usage, traces, annotations,
  cancellation, budget, and a deadline.
- **Checkpoint** — a fingerprinted record of a successful stateless run, replayed on reruns so
  finished steps don't bill again.
- **Trace** — one structured, append-only event log per run: nested runs, tools, prompts, output,
  usage, checkpoints, and errors under a single trace identity.

How the pieces sit together:

```
+------------------+        +-------------------+
|   unigent CLI    |        |    unigent tui    |
|  (runs script)   |        | (live inspector)  |
+--------+---------+        +---------+---------+
         |                            ^
         | spawns                     | trace events (isolated channel)
         v                            |
+-------------------------------------+----------+
|            your TypeScript script              |
|        agent / run / session / scope           |
+------------------------+-----------------------+
                         |
              +----------v----------+
              |   harness adapter   |
              +--+--------+--------+-+
                 |        |        |
          +------v-+ +----v-----+ +-v---------+
          | Pi SDK | | Claude   | | Codex CLI |
          |        | | CLI      | |           |
          +--------+ +----------+ +-----------+
```

The SDK talks to each harness through a small adapter that opens sessions, runs turns, executes
Unigent tools, streams events, reports usage, and forks conversations where supported.

---

## Choose what comes back

Every run starts with `.run(prompt)`. The optional second argument controls what comes back: pass a
schema for a typed value or `done` for side-effect-only work.

```typescript
import { done } from "unigent-sdk";
import { z } from "zod";

const prose = await writer.run("Explain the tradeoff.");

const structured = await writer.run(
  "Choose the strongest title.",
  z.object({ title: z.string(), score: z.number().min(0).max(100) }),
);

await writer.run("Update CHANGELOG.md.", done);
```

- Omit the second argument to return prose.
- Pass a Standard Schema to return its inferred type.
- Pass `done` when the work ends with side effects and no prose result is useful.

`done` is a built-in completion sentinel schema. Passing it as the
second argument makes Unigent expose the reserved `unigent_return` tool with an empty object input
schema. The agent is instructed to call that tool after completing the requested side effects. An
accepted call returns `void` and terminates the run before the agent writes a final prose response,
saving tokens that the caller would otherwise discard.

Structured output uses the same completion-tool protocol. Instead of the empty sentinel schema,
`unigent_return` accepts a `value` matching the schema passed to `run()`.

Structured values therefore never need to be scraped from prose: Markdown, preambles, and trailing
commentary cannot corrupt the value. If the agent omits the completion call or returns an invalid
value, Unigent repairs the turn a bounded number of times and then throws
`AgentRepairExhaustedError`.

## Give agents tools

Pass ordinary named functions. Unigent reads their TypeScript signatures and JSDoc from the module
named by `source`, then builds the tool definitions for the harness.

```typescript
/** Return the number of words in some copy.
 *
 * @promptSnippet Use this before accepting copy with a word limit.
 * @promptGuideline Do not call wordCount repeatedly with unchanged text.
 */
function wordCount(text: string): number {
  return text.trim().split(/\s+/u).length;
}

const editor = agent({
  name: "editor",
  source: import.meta.url,
  backend: piAgent(),
  model: "openrouter/deepseek/deepseek-v4-flash",
  tools: [wordCount],
});
```

The opening JSDoc prose is the tool description; there is no `@description` tag. Both prompt tags
are optional. `@promptSnippet` adds a named entry to the system prompt's available-tools section.
Each `@promptGuideline` becomes a standalone bullet in its guidelines section, without an automatic
tool-name prefix, so every guideline must name its tool explicitly. This distinction follows Pi's
native semantics. Claude Code and Codex do not expose equivalent tool fields, so Unigent renders
both sections itself for every harness instead of appending either tag to the tool description.
Omit the tags when that extra guidance is not worth its token cost. When TypeScript source is
unavailable, the portable `tool({...})` helper accepts an explicit Standard Schema input.

For compiled deployments, bake source-derived schemas after compiling the entry:

```bash
tsc && unigent bake src/worker.ts
```

This writes `worker.unigent-tools.json` beside the compiled `worker.js`. Production loads that
manifest without installing or loading TypeScript; development can continue reflecting directly
from a `.ts` entry when the optional `typescript` peer is installed.

Only values listed in `tools` are callable. Deliberate agent failure is also opt-in:

```typescript
import { fail } from "unigent-sdk";

const reviewer = agent({ ...options, tools: [fail] });
```

Unigent does not rename ordinary function tools: `wordCount` is advertised as `wordCount`. To the
agent, `unigent_fail` is another callable tool. It is special only at the TypeScript boundary:
ordinary tool errors are recoverable feedback for the agent, while `unigent_fail` terminates the
run and throws `AgentRaisedError` to the caller. Adding the `fail` sentinel opts the agent into that
control tool; agents cannot deliberately abort a run unless the developer enables it. User-defined
names beginning with `unigent_` are rejected because that namespace belongs to protocol tools such
as `unigent_return` and `unigent_fail`.

## Compose agents with functions

An agent becomes a nested agent when you call it from a tool function.

```typescript
const researcher = agent({
  name: "researcher",
  backend: piAgent(),
  model: "openrouter/deepseek/deepseek-v4-pro",
});

/** Research one question and return a concise finding. */
async function research(question: string): Promise<string> {
  const result = await researcher.run(question);
  return result.output;
}

const author = agent({
  name: "author",
  source: import.meta.url,
  backend: piAgent(),
  model: "openrouter/deepseek/deepseek-v4-flash",
  tools: [research],
});
```

When the author calls `research`, the function opens another Unigent run. The nested run keeps its
trace parentage, and its usage rolls up into the parent. The surrounding program still decides how
many agents run, which work happens in parallel, and where results go next.

## Keep a conversation and branch it

Stateless runs are the default. A session keeps the harness conversation for later turns.

```typescript
const review = reviewer.session();

await review.run(`
Read the repository and learn its architecture, conventions, and current behavior.
Trace the main execution paths and note the patterns that new code should follow.
Do not review or modify anything yet; reply when you have enough context.
`);

const correctnessReview = review.fork();
const maintainabilityReview = review.fork();

const [correctness, maintainability] = await Promise.all([
  correctnessReview.run("Review the codebase only for correctness and edge-case failures."),
  maintainabilityReview.run("Review the codebase only for maintainability and API clarity."),
]);
```

Both branches reuse the repository context gathered by the first turn instead of paying to rebuild
it independently. All three official harnesses support forks. A session can be forked after its
first completed turn, but not while a turn is active.

## Group a workflow with scopes

A scope groups related runs and owns their cumulative usage, traces, annotations, logs,
cancellation, and deadline.

```typescript
const release = writer.scope("release", {
  duration: "10m",
  retainTraces: 50,
  limits: { budgetUsd: 1 },
});

release.annotate({ pullRequest: 42 });
release.log("drafting release notes");

const draft = await release.scope("draft").run("Draft the notes.");
await release.scope("publish").run(`Publish these notes: ${draft.output}`, done);

console.log(release.usage);
console.log(release.traces);
```

`.with(overrides)` returns an immutable agent variation with different configuration, such as a
model, backend, system prompt, or per-turn limits. It does not create a new lifecycle or telemetry
group; runs still belong to the current scope.

`.scope(name, options)` creates a named workflow boundary. It can apply the same configuration
overrides, but it also owns aggregate usage and traces, annotations and logs, cancellation, and an
overall `duration` deadline. Nested scopes roll their usage and traces into their parent. Inherited
limits can only tighten: `limits.turnDuration` caps each agent turn, while the scope's `duration`
caps the whole grouped workflow. Explicit scopes retain the latest 50 completed root traces by
default; set `retainTraces` to another bound or `0` to disable retention. Each run still returns its
complete trace as `result.trace`.

## Run and inspect scripts

The CLI runs an ordinary TypeScript file as a child process. The file needs no TUI-specific code.
Everything after the script path is forwarded to the script. A conventional `--` separator is
also accepted for compatibility with command generators that insert one, but Unigent does not
need it: its own option parsing stops at the script path.

```bash
unigent examples/pitch.ts "Kebab shop app"
unigent tui examples/pitch.ts "Kebab shop app"
```

Trace events travel over an isolated channel, leaving the script's stdout and stderr alone. The
TUI shows the live run tree, transcript, system prompt, tool calls, usage, errors, and process
output.

<p align="center">
  <img src="https://github.com/gintasz/unigent/raw/refs/heads/main/assets/tui.png" alt="Unigent live trace inspector" width="1100" />
</p>

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select a trace row |
| `Enter` | Expand or hide the selected agent's tool calls |
| `s` | Show or hide the system prompt |
| `o` | Switch between activity and process output |
| `[` / `]` | Page through older or newer trace history |
| `r` / `Ctrl-R` | Rerun or stop |
| `q` | Quit |

The trace retains its complete history in 250-row pages, and the activity pane keeps only its latest
250 entries mounted. Both panes use viewport culling so off-screen content is not painted.

### Drop-in Bun scripts

For small automations, a single Bun script is often more comfortable than adding a `package.json`,
lockfile, and local dependencies to a project. Start the file with `#!/usr/bin/env bun`; Unigent's
CLI will use Bun in both normal and TUI mode, with missing-package fallback enabled. Imports are
downloaded into Bun's global cache instead of creating project boilerplate.

Copy [examples/standalone.ts](https://github.com/gintasz/unigent/blob/main/examples/standalone.ts)
into a project and launch it through Unigent:

```bash
unigent standalone.ts "Write a launch announcement"
unigent tui standalone.ts "Write a launch announcement"
```

The same file is directly executable when you do not need Unigent's trace transport or TUI:

```bash
chmod +x standalone.ts
./standalone.ts "Write a launch announcement"
```

Pi reads models and authentication from your local Pi configuration. The Claude and Codex
adapters use the authenticated official CLIs installed on your machine.

👉 Your agent can invoke such workflow scripts with a bash command, isn't that cool?

## Parse script arguments

`args()` parses `process.argv` through any Standard Schema. A scalar schema joins positional
arguments into one natural value:

```typescript
import { args } from "unigent-sdk";
import { z } from "zod";

const idea = await args(z.string().min(1));
```

The second argument is optional. Add it only when the script needs more useful `--help` output:

```typescript
const idea = await args(z.string().min(1), {
  description: "Turn a product idea into an elevator pitch.",
  usage: '"Product idea"',
});
```

Ask the script to print the generated help without starting an agent run:

```console
$ unigent examples/pitch.ts --help
Turn a product idea into a scored elevator pitch.

Usage: pitch.ts "Product idea"

Options:
  -i  Prompt for missing required arguments.
```

`args()` prints this standardized usage for `-h` or `--help`. Invalid input prints the schema's
validation message and the same usage before exiting. Zod's default messages work without any
authored message; customize them only when the default is not clear enough for your script.

Object schemas accept named flags, defaults, repeated arrays, dotted paths, booleans, and `--no-*`
negation:

```typescript
const input = await args(
  z.object({
    keyword: z.string().describe("The keyword to transform"),
    count: z.number().int().positive().default(1),
    cache: z.boolean().default(true),
  }),
);
```

```bash
unigent task.ts --keyword kebab --count 3 --no-cache
```

`--no-cache` sets the `cache` field to `false`; `--cache` sets it to `true`. The `no-` prefix is a
conventional CLI negation for boolean flags, not part of the schema field name.

```console
$ unigent task.ts --count 3 -i
--keyword (The keyword to transform): kebab
```

`-i` prompts for missing required arguments; descriptions are optional. It requires a terminal and
is unavailable in TUI or piped execution. Without `-i`, missing input fails immediately.

## Resume finished work with checkpoints

Checkpoints reuse successful stateless runs across reruns and deduplicate identical concurrent
calls. Their fingerprint covers the prompt, return schema, harness adapter, model, system
prompt, tools, and explicit checkpoint keys.

```typescript
import { agent, createFileCheckpointStore } from "unigent-sdk";

const defaults = {
  backend: piAgent(),
  checkpoint: createFileCheckpointStore(".unigent/checkpoints.jsonl"),
  limits: { turnDuration: "5m" as const },
};

const writer = agent({ ...defaults, name: "writer", model: "model-a" });
const reviewer = agent({ ...defaults, name: "reviewer", model: "model-b" });
```

Set `checkpointKey` when closed-over or ambient behavior changes the run's identity. Use
`.with({ checkpoint: false })` for a fresh branch. Stateful session turns always run fresh because
their result depends on the conversation transcript. A checkpoint replay restores the recorded
usage, including `costUsd`; scope telemetry and budgets therefore describe the logical workflow,
not only newly billed backend calls.

Budget enforcement is exact for sequential work. Parallel siblings can each begin below the same
remaining budget because their costs are unknown until they settle; a sibling that takes the scope
over budget rejects after settlement, but the provider spend has already occurred.

## Test without a model

The SDK includes a deterministic harness adapter under its `test` subpath, so tests need no second
Unigent package.

```typescript
import { agent } from "unigent-sdk";
import { createScriptedBackend } from "unigent-sdk/test";
import { z } from "zod";

const backend = createScriptedBackend([
  {
    toolCalls: [
      { name: "unigent_return", input: { value: { title: "Unigent" } } },
    ],
  },
]);

const subject = agent({ name: "subject", backend, model: "test" });
const result = await subject.run("Name the project.", z.object({ title: z.string() }));

expect(result.output).toEqual({ title: "Unigent" });
expect(backend.requests).toHaveLength(1);
```

`createTestBackend` accepts a programmable turn handler. `createScriptedBackend` consumes
declarative turns. Adapter authors can use `exerciseBackendContract` to run the shared prose,
session, and fork contract against a new harness adapter.

## Harnesses

Unigent talks to each harness through a small adapter that opens sessions, runs turns, executes
Unigent tools, streams events, reports usage, and forks conversations where supported.

```typescript
import { claudeCli, codexCli, piAgent } from "unigent-sdk";

const pi = piAgent();
const claude = claudeCli();
const codex = codexCli();
```

All three adapters default to `base: "clean"`, which starts without the machine's prompt,
plugins, skills, hooks, or MCP configuration. Authentication, model configuration, and each
harness's native tools remain available unless you restrict them. Set `base: "machine"` to inherit
ambient harness configuration.

| Capability | Pi agent SDK | Claude CLI | Codex CLI |
| --- | --- | --- | --- |
| Prose, structured output, `done`, `fail`, tools | Yes | Yes, through ephemeral local MCP | Yes, through ephemeral local MCP |
| Cost reporting and budget enforcement | Yes | Yes | No; budget configuration fails fast |
| Session continuation and forks | Yes | Yes, through CLI resume/fork flags | Yes; forks copy Codex's persisted session transcript under a new session ID |
| Native tools | Exact allowlist; `[]` disables | `--tools` allowlist; may retain `ToolSearch` for MCP | `[]` disables shell and web search; no exact allowlist |
| Plugins | Exact allowlist or disable | Exact installed-plugin allowlist or disable | No Unigent control |
| Skills | Exact allowlist or disable | Inherit all with machine base or disable all; no named allowlist | Exact allowlist or disable |
| Machine MCP servers and hooks | Pi has no built-in MCP; MCP extensions and hooks follow plugin selection | Inherit all with machine base or disable all; no named allowlist | Clean base ignores user config and rules; machine base inherits |
| Permissions | Harness execution is unrestricted | Bypassed by default; `permissions: "cli"` defers to Claude | Bypassed by default; `permissions: "cli"` defers to Codex |

Explicit adapter options override the inherited category where the harness can enforce them.
Unsupported controls fail during setup instead of becoming silent no-ops.

## Development

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm test
corepack pnpm run test:tui
corepack pnpm run test:e2e
corepack pnpm run check:full
```

The deterministic suite uses no model. `test:tui` drives a real terminal without a model.
`test:e2e` spends real Pi, Claude CLI, and Codex CLI turns and requires all three local harnesses
to be authenticated.

## License

[MIT](https://github.com/gintasz/unigent/blob/main/LICENSE) © 2026 Gintas Zenevskis
