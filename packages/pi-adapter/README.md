# @microfoom/pi-adapter

The reference microfoom **harness adapter**, over the [pi](https://github.com/earendil-works/pi)
agent. It is the sole binding between core's harness port (`OpenSession` /
`HarnessSession`) and pi's runtime: it implements that port so microfoom programs
run against a real model. It carries no extension or TUI concerns — those live in
`@microfoom/pi-extension`. Both it and `@microfoom/cli` consume this package.

## Programmatic use

```ts
import { runProgram } from "@microfoom/core";
import { createPiOpenSession } from "@microfoom/pi-adapter";

const result = await runProgram(MyProgram, input, {
  openSession: createPiOpenSession(), // model + API key resolved from ~/.pi
  model: "openrouter/deepseek/deepseek-v4-flash",
  sourceFile: "./my-program.ts",
});
```

Each turn runs a `pi-agent-core` `Agent` whose loop owns the model calls and
executes the FOOM operations as native pi tools; a microfoom `session()` reuses one
`Agent` so the transcript carries across turns. `createPiOpenSession` accepts
overrides (`streamFn` / `resolveModel` / `logFile`) for tests or custom wiring.

## Run logging

Set `MICROFOOM_LOG` (or `createPiOpenSession({ logFile })`) to append a JSONL
record per model turn — prompt, advertised tools, the assistant/tool messages, and
any error. Best-effort and bounded; the first thing to check when a run misbehaves.
