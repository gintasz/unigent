# ADR-0003: Control-tool mapping, exposure tiers, and TS-signature schema derivation

- **Status:** accepted
- **Date:** 2026-06-26
- **Constitution refs:** F2, F3, F4, F7, C3

## Context

The agent affects the program only through a fixed set of structured control
tools surfaced as native function-calling (F2), never string-matched. Exposed
methods are advertised in tiers that differ by context cost (F3). Returns are
validated against a Standard Schema; the library commits to no concrete validator
(F4). The open question: how is the model-facing parameter schema for an exposed
method produced, given Standard Schema offers no guaranteed JSON-Schema export but
the provider needs JSON Schema upfront?

## Decision

### Control tools (F2)
Four control tools whose semantics live in core (`tools.ts`) and
are executed by the harness loop (ADR-0002), never parsed from text:
- **`foom_call`** — invoke an exposed method (by name + args). Generic tool for the
  silent/announcement tiers; the `{ tool }` tier additionally gets its own native
  tool.
- **`foom_return`** — terminal structured return; its value is validated against the
  call's Standard Schema (F4) and ends the turn.
- **`foom_throw`** — deliberate program error carrying a caller-defined `code`
  (→ `FoomThrowError`, F7).
- **`foom_inspect`** — returns an exposed method's parameter schema on demand.

### Exposure tiers (F3) — agent-unreachable by default
- bare `@foom.expose` — silent: reachable, not advertised; params via `foom_inspect`.
- `{ announcement }` — name+description in the system prompt; params via `foom_inspect`.
- `{ tool }` — own native tool with **full parameter schema upfront**.
- `private`/`protected`/`#private` members can never be exposed (ast-grep + review).

### Parameter schema = derived from the TS signature at load (DECIDED UPFRONT)
A program is loaded from source (`runProgram` is given the `sourceFile`; not
bundled), so the TS parameter types are available at load. A load-time derivation
pass reads each exposed method's signature and produces a **JSON Schema**, used for:
- the upfront advertisement of `{ tool }`-tier methods (mapped to the provider's
  schema type — typebox `TSchema` for pi-ai — in the harness adapter), and
- `foom_inspect` responses for all tiers.

Argument validation (F4) wraps the same derived JSON Schema as a `StandardSchemaV1`
so "Standard Schema is the one validation contract" holds end-to-end; the author
never writes `parameters`. Derived schemas are cached per file (startup-latency
note, not correctness). Return validation uses the caller-supplied Standard Schema
from `value(schema)`.

**Rejected alternatives:** `foom_inspect`-only with no upfront schema (loses the
`{ tool }` tier's upfront advertisement — the documented end state); requiring the
author to attach a JSON-Schema-emitting validator (re-introduces an authored
`parameters` and a concrete-validator lean, against F4).

## Consequences

The derivation is implemented in `schema_derive.ts` (`deriveMethodParameters`)
using the TypeScript compiler API directly, so core gains a `typescript` runtime
dependency. The pi harness maps the neutral JSON Schema to typebox (`Type.Unsafe`)
for `pi-ai` tools. Erased-at-runtime TS types are recovered by a compiler pass at
load; results are cached per file. `runProgram` therefore needs the program's
`sourceFile` for `foom_call` parameter derivation.
