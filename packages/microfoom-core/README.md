# @microfoom/core

The harness-agnostic microfoom runtime. It owns the program model and the FOOM
tool semantics; a harness (e.g. `@microfoom/pi`) owns the model loop and executes
the tools. The public surface is plain Promise/`throw` — no Effect type leaks out.

## What it provides

- **`Program(schema)` / `FoomtimeProgram`** — base class; `main(input)` is typed
  from the input Standard Schema.
- **`@foom.config` / `@foom.expose`** — class/method config cascade and capability
  exposure (methods are unreachable until exposed; language-private members never).
- **`this.agent`** — `text\`…\`` (prose) and `value(schema)\`…\`` (validated
  structured return), plus `session()` (stateful), `with(options)`, and `usage`.
- **Parameter-schema derivation** — an exposed method's JSON Schema is derived from
  its TypeScript signature at load (`deriveMethodParameters`).
- **Error taxonomy** — `FoomtimeError` and subclasses (`FoomtimeThrowError` with a
  caller code, `FoomtimeRepairExhaustedError` with a `channel`, cap/abort/harness errors).
- **Harness port** — `HarnessSession` / `OpenSession` + neutral `NeutralToolDef`;
  what a harness implements. Run with `runProgram(ProgramClass, input, options)`.

## Config cascade (F5)

`harness defaults → @foom.config (class) → @foom.config (method) → per-call .with()`.
Caps (`max*`) tighten only; `systemPrompt` composes (`append`/`replace`); everything
else is nearest-scope-wins.

## Trace (opt-in)

`import "@microfoom/core/trace"` augments the run context with `onEvent` / `export`
/ `scope` over the intrinsic event stream. The common path imports none of it.

Validation commits to no concrete validator — bring any
[Standard Schema](https://standardschema.dev) (Zod, etc.).
