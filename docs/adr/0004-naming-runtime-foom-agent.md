# ADR-0004: Naming — runtime, Foom\*, Agent\*, framework

- **Status:** accepted
- **Date:** 2026-06-29
- **Constitution refs:** N5, F2, A1, F6, X2, I1

## Context

The codebase named its single internal turn-executing component four ways — `runtime`, `engine`, `run engine`, and `Foomtime` (the program base + the 16-class error taxonomy). `Foomtime` was the project's old codename (it was renamed to microfoom). The public surface mixed a `Foomtime*` family with an `Agent*` family for what is one subsystem, so a consumer could not tell they relate. This violates N5 (one term per concept across code and prompts) and read as accidental inconsistency on a public, pre-1.0 surface.

The naming was settled from what each thing *is* (a DNA test), not from file-headcount or from deferring to the constitution.

## Decision

- **`runtime`** is the one name for the internal turn-executing component (the run-context + turn executor that runs the repair loop, caps, and dispatch). The DNA test: *does your code run **inside** it (runtime) or do you hand work **to** it (engine)?* The program and the model run **inside** it, and it is a threaded run-context carrying services — the in-process-runtime shape of Effect's `Runtime` / a Tokio runtime, not a VM/sandbox. `engine`/`run engine` are retired: there is no distinct doer-object, so "engine" named a referent that does not exist.
- **`Foomtime` is eliminated** as dead codename. The program base and the error taxonomy take the **`Foom*`** stem (`FoomProgram`, `FoomError`, `FoomAbortError`, …). `foom` is live protocol vocabulary (`foom_call`/`foom_return`, the `@foom` decorator), so the framework-identity types tie to the real protocol stem.
- **Two stems, each with one job:** `Foom*` = framework identity (the base class you extend, the error taxonomy you catch); `Agent*` = the runtime-domain objects you work with (`AgentRun`, `AgentSession`, `AgentResult`, `AgentUsage`, `AgentConfig`, and the `this.agent` handle).
- **`this.agent` is kept** — you *command the agent* through it (`this.agent.value()/.do()/.prose()`); the runtime is the substrate that executes the command. Naming it `this.runtime` would re-conflate the worker with the substrate. This is decided on merit, not on F6.
- **`framework`** is the project's genus word (three IoC inversions: lifecycle bootstrap, capability dispatch, observation hooks). It lives in docs/positioning only, never as a code identifier. The core itself is "an agent runtime."
- **`control tool`** is the one name for the four `foom_*` primitives (matching the public identifiers `CONTROL_TOOLS`/`ControlToolName`/`isControlTool`); "control operations" and the dead "keyword" term are retired. "FOOM tools" is an alias for the same set.

## Consequences

- F6 is clarified by amendment: it forbids the internal `Runtime` *type/abstraction* from leaking into a public export or generated `.d.ts` — it does **not** ban the *word* "runtime"/"run" from a public identifier name. It therefore never governed `this.agent` or the hooks type.
- The error taxonomy class names change (`Foomtime*Error` → `Foom*Error`); since all consumers are in-repo (I3/X1) this lands in one change with its call sites and tests updated.
- The constitution is treated as a candidate for change, not an authority: where a rule blocked higher coherence it was amended (A1, F6, X2, F2, I1), not worked around.
