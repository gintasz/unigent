# ADR-0002: pi-extension deployment; the harness owns the turn loop

- **Status:** accepted (revises the initial "core owns the loop" decision). NOTE
  2026-06-27: the pi-*extension* deployment described below was prototyped then
  removed — the agent invokes programs via the CLI (`microfoom run`) over bash. The
  decision here — **the harness/adapter owns the loop** — is unchanged and
  load-bearing; only the delivery surface changed (extension → CLI).
- **Date:** 2026-06-26
- **Constitution refs:** A1, A3, F1, F2, F6, F8, X2, L2, C3

## Context

microfoom's deployment target is a **pi extension**: a user installs it into their
`pi` agent, runs `pi`, and types `/microfoom-run <program>`. The four FOOM
operations are native pi tools; pi's agent loop calls them. The initial design
("core owns the loop; the harness is a single `streamSimple` call") does not fit —
in the real deployment **pi owns the model loop and executes the tools**.

## Decision

- **The harness owns the loop.** Core defines a Promise-based `HarnessSession`
  port: `runTurn(systemPrompt, prompt, tools)` drives the model and executes the
  supplied tools, resolving when a tool signals `terminate` or the model stops.
- **Core owns the tool semantics + one shared coordinator** (`tools.ts`): the FOOM
  tool handlers (dispatch an exposed method, validate+capture a return, throw with
  a code, inspect a schema) and the thin `runProgramTurn` that interprets the
  captured outcome and enforces caps. Both the pi session and the deterministic
  faux test session drive the *same* handlers — no duplicated loop.
- **`@microfoom/pi-adapter`** maps neutral ↔ pi: each turn runs a `pi-agent-core`
  `Agent` (its loop, FOOM ops as `AgentTool`s) with model + auth resolved from
  `~/.pi` (coding-agent `ModelRegistry`/`AuthStorage`) and `pi-ai` providers. The
  CLI (`microfoom run`) loads a program and runs it against a programmatic pi
  sub-session per run.
- **Effect-internal (X2/L2) is superseded.** With the loop owned by pi, core is no
  longer an Effect program: domain logic is pure values, usage accounting stays a
  `@effect/typeclass` Monoid (OB3), and the harness seam is plain Promise with the
  thrown public taxonomy (F7). The `effect` runtime dependency is dropped from the
  core. F6 (Effect-free public surface) is trivially upheld; the no-raw-try ast-grep
  rule (which enforced X2) is removed.

## Consequences

The core stays harness-agnostic (A3): it never imports pi; the contract is the
`HarnessSession`/`OpenSession` port + neutral tool defs. Future harnesses implement
that port. The faux session keeps the deterministic suite green without a model.
Dropping Effect-internal is a deliberate amendment recorded here (P6); revisit if a
future harness needs core-side structured concurrency.
