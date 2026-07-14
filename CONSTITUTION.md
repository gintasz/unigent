# Constitution — unigent

> Smallest verdict set keeping agents coherent here. Where silent: follow the dominant
> pattern in the nearest existing code, unless it contradicts a verdict. If a task seems
> to require violating a verdict: stop, cite the ID, propose an amendment — never violate
> silently.

## Precedence

1. Legal/safety · 2. Security & correctness · 3. This document · 4. Nearest code · 5. Preference (never wins).

Virtues, when compliant options tension (cite by number): 1. conceptual integrity · 2. locality of reasoning (binding — the primary authors are context-bounded agents) · 3. uniformity/composability · 4. correctness by construction + totality · 5. legibility/observability. Deliberately not maximized: runtime performance (measure first), reversibility (lock-in is accepted knowingly), density/brevity (never bought at locality's expense).

## Identity — violating one is not a feature, it is a different project

- **ID1.** Deterministic host, fuzzy agent: orchestration (control flow, recursion, arithmetic, branching, parallelism) lives in TypeScript; the model is invoked only for genuinely fuzzy work. Driving deterministic logic through the model is an anti-pattern, not a capability. (review)
- **ID2.** Structured completion, never string-matched: prose is unconstrained, while schema returns, side-effect completion, and deliberate failure flow only through reserved native tools; never parse control out of free text. (review)
- **ID3.** Capability security: nothing is agent-callable until explicitly opted in; language-private members can never be exposed; advertisement tiers differ only by context cost, never by privilege. (tool: custom pattern check + review)
- **ID4.** Validator-agnostic structured returns: machine-readable returns flow through the structured channel against a Standard Schema contract; the library commits to no concrete validator; the prose channel is never schema-validated. (review)
- **ID5.** Config cascades widest→narrowest by declared discipline per option kind: caps merge tighten-only, composable options compose, everything else nearest-scope-wins; a cap that cannot be enforced fails fast at setup, never a silent no-op. (review; property tests pin cap monotonicity)
- **ID6.** Conventional facade: a consumer writes idiomatic Promise/`async`/`try-catch` TypeScript; failure surfaces only as thrown taxonomy errors; the internal runtime abstraction never appears in any public export or generated declaration. (tool: public-surface report + import-graph + review)
- **ID7.** Core/adapter split: all reusable language/runtime logic lives in the generic core; a harness adapter and any frontend contain only glue. (review)

## Verdicts

- **V1. Dependency direction** — specific imports generic, never the reverse: adapters and frontends import the core; the core imports no harness and nothing harness-shaped. The protocol surface (control-tool definitions, prompts, operator commands) is defined once in the generic layer; adapters consume it, never redefine it. (tool: import-graph + review)
- **V2. Paradigm** — plain strict TypeScript: domain logic as pure values and functions; classes only for genuinely stateful adapters and the public surface; `Promise`/`AbortSignal` at the edge. Do not layer a functional-runtime substrate (Effect-style) over the language. (review)
- **V3. Errors** — one typed taxonomy: distinct subclasses per category under one base, `instanceof`-discriminated; deliberate agent-raised failure is a distinct class from infrastructure failure; boundary failures are kinded by retryability. No hand-rolled `Result`/`Either`, no stringly-typed failures, no exceptions as ordinary control flow. (review)
- **V4. Failure handling** — recoverable agent faults are repaired in-band by the bounded repair loop until attempts are exhausted; programmer errors and contradictory state fail fast; caps live in shared policy and guarantee every run terminates. (review)
- **V5. State** — per-run mutable state lives on one threaded run-context; terminal state has exactly one writer; usage accounting folds through an associative combine (monoid), never hand-summed; nested runs fold into the parent without double counting. (review)
- **V6. Sessions** — stateful sessions are single-flight: an overlapping turn is a typed defect, parallelism goes through the explicit fork primitive; stateless turns are concurrency-safe; cancellation propagates abort and rejects with a taxonomy error. (review + tests)
- **V7. Boundaries & types** — parse, don't validate: untrusted input is parsed once at the boundary into a precise type and the interior never re-validates; outcomes are closed discriminated unions, never bags of optional flags; absence is `undefined`, never `null`; the live model and its wire snapshot are separate types with one projector between them. (review)
- **V8. Casts** — unsafe casts are confined to vendor-wrapper modules; anywhere else a cast must surface in review, not be silenced. (review)
- **V9. Dependencies** — adopt over build: prefer a well-maintained dependency to reimplementing non-trivial behavior; contain wide-surface vendors behind a single wrapper module so a swap is a one-module change. (review)
- **V10. Compatibility** — break-freely: all consumers are in-repo; a breaking change lands with every call-site update in the same change; backcompat shims, deprecation scaffolding, and dual code paths are defects. (review)
- **V11. Testing** — the deterministic suite gates merge; real-LLM e2e is a separate diagnostic suite that skips (never fails) on provider/auth errors — red there is a real regression; the deterministic library layer is exercised with property-based invariants, not only examples; coverage is a diagnostic, not a gate; a bug fix lands with the test that pins it. (tool: CI + review)
- **V12. Observability** — one structured, append-only event log with a single writer and bounded fields, best-effort and never a failure path; one trace identity ties each run to its nested runs, tools, prompts, output, usage, checkpoints, and errors. (review)
- **V13. Decision records** — an ADR only for decisions costly to reverse or genuinely divergent; the toolchain is one repo-wide set whose concrete members live in the ADR catalogue, never named here; a same-role tool swap is a catalogue edit, not a new ADR. (review)
- **V14. Ubiquitous language** — one term per concept across code, prompts, and docs; before coining a name, find the existing term and reuse it; do not introduce synonyms for established domain terms. (review)
- **V15. Guard the gain** — when a boundary is established or repaired, land the mechanical rule (arch check, test) that keeps it in the same change. (review)

## Judgment layers

- **J1.** Fuzzy-or-deterministic (ID1): if the logic can be written as ordinary code, write code; spend a model turn only where the work genuinely needs judgment or language.
- **J2.** Core-or-adapter (ID7): reusable across harnesses → core; harness-specific translation → adapter. When unsure, start in the adapter and promote on the second consumer (AHA).
- **J3.** Public-surface curation (ID6): a barrel exports deliberately; adding an export is an API decision, reviewed via the surface report diff — never an incidental re-export.
