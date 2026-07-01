# ADR-0001: Toolchain and monorepo layout

- **Status:** accepted (revised 2026-06-27: renamed `@microfoom/pi` →
  `@microfoom/pi-adapter`. A pi extension + a shared `@microfoom/trace-view`
  package were prototyped then removed — the agent invokes programs via the CLI
  over bash, leaving one frontend, so neither earned its keep; the trace renderer
  folded back into the CLI.)
- **Date:** 2026-06-26
- **Constitution refs:** L1 (toolchain), A1, A2, A3, A4, DEP2, DEP3, C3 — plus the enforcement-class citations in B2, B9, L3, N5, T1, OB1, OB3, Q6, F3, F6, F8, V1 that name a tool *class* and defer the concrete instance here. (X2/L2/S1 — Effect-internal — are **superseded by ADR-0002**.)

## Context

microfoom is a greenfield, harness-agnostic runtime plus harness adapters. The
constitution (L1) fixes a single repo-wide toolchain *in principle* but
deliberately names no concrete tool (P1/P2): constitution rules cite an
enforcement *class* (e.g. "import-graph checker", "public-surface reporter"),
and **this ADR is the single source of truth that binds each class to a concrete
instance**. Recording it here — not in the constitution — keeps the constitution
churn-free across tool swaps; a swap is a deliberate amendment (P6) to this ADR,
not an edit to the governing principles.

## Decision

- **Monorepo:** pnpm strict workspaces. Packages:
  - `@microfoom/core` (`packages/microfoom-core`) — generic, harness-agnostic
    runtime and language logic. Depends on no harness.
  - `@microfoom/pi-adapter` (`packages/pi-adapter`) — the reference harness
    **adapter**: the sole binding from core's harness port (`OpenSession` /
    `HarnessSession`) to the `@earendil-works` pi runtime (`pi-agent-core` `Agent`,
    `pi-coding-agent` ModelRegistry/AuthStorage, `pi-ai` providers). Thin glue, no
    extension/TUI concerns. Consumed by the CLI.
  - `@microfoom/cli` (`packages/microfoom-cli`) — the `microfoom run` CLI
    frontend: runs a program file (result → stdout, live trace → stderr), with the
    run-trace rendering (RunNode → panel string) and a faux session living here.
    Depends on pi-adapter and core. (The agent invokes programs by shelling out to
    this CLI; core stays paint-free — F8.)
  - Dependency direction (A3): cli → {pi-adapter, core}; pi-adapter → core; core
    imports nothing downstream and no harness. The adapter never imports the cli
    (enforced by dependency-cruiser).
- **Build/types:** TypeScript strict + `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`;
  ESM, NodeNext; `tsc -b` project references are build-authoritative; ts-reset for
  a sound stdlib (T1).
- **Schema:** `@standard-schema/spec` only; no concrete validator is a library
  dependency (F4).
- **No Effect.** Domain logic is plain TypeScript; the usage monoid (OB3) is a
  small hand-written `combineUsage`/`emptyUsage` (its laws pinned by property
  tests). Effect-internal was dropped with ADR-0002; with `effect` gone, the
  `@effect/eslint-plugin` rule was removed. biome is the primary linter/formatter,
  with a thin type-aware ESLint layer (typescript-eslint, `eslint.config.js`) for
  the `no-unsafe-*` family and other rules biome's shallow inference can't express.
- **Format/lint/arch:** biome (format + lint), typescript-eslint (type-aware lint
  for the `no-unsafe-*` family), dependency-cruiser (layer/import rules), ast-grep /
  `@ast-grep/cli` (in-file bans biome can't express), api-extractor (`.api.md`
  surface report).
- **Test:** vitest + fast-check (property-based), transformed by **SWC**
  (`unplugin-swc`) because the default Vite transform (oxc) does not lower the
  TC39 decorators that `@foom.config`/`@foom.expose` use.
- **Hygiene:** syncpack (one version per dep, exact), knip (dead code), jscpd
  (duplication), typos (spell — CI installs pinned binary via taiki-e/install-action;
  local dev-provided), lefthook (DoD gate, git hooks).
- Package **directory** names are kebab-case (ecosystem norm); **source files**
  are snake_case (N1), enforced by biome's filename rule scoped to `packages/*/src`.

### Enforcement class → instance (resolves the constitution's class names)

| Constitution class | Instance | Rules |
| --- | --- | --- |
| formatter / linter | biome | B2, B7, L3, N1, N2 |
| type-aware linter | typescript-eslint (`eslint.config.js`) | L3 (no-any-leak via `no-unsafe-*`), T1 |
| custom code-pattern checker | ast-grep (`@ast-grep/cli`) | L3, F3 |
| import-graph / arch checker | dependency-cruiser | A2, A3, A4, F6, F8, Q4, DEP2 |
| public-surface reporter | `@microsoft/api-extractor` (`.api.md`) | A2, F6 |
| type checker | `tsc -b` (strict + beyond-strict flags) | T1 |
| sound-stdlib lib | ts-reset | T1 |
| schema contract | `@standard-schema/spec` | F4, DEP2 |
| test runner + transform | vitest + SWC (`unplugin-swc`) | Q2, Q6 |
| property-based-testing engine | fast-check | Q6 |
| dead-code checker | knip | B2 |
| duplication detector | jscpd | B9 |
| version-policy checker | syncpack | DEP3 |
| spell checker | typos — CI installs the pinned binary via `taiki-e/install-action` (version pinned in `ci.yml`) and runs it through `check:full`; local install developer-provided, not lockfile-pinned (L1 pinning exception: no npm distribution) | N5 |
| git-hook runner | lefthook | V1, DOD |
| usage-accounting monoid | hand-written `combineUsage`/`emptyUsage` (core) | OB3 |
| event renderer | core `formatEvent`/`consoleExporter` (`@microfoom/core/trace`) | OB1 |

## Consequences

Every gate runs locally (lefthook) and in CI before merge. Swapping a toolchain
member for another in the same role is a catalogue edit in the table above (C3),
not a new ADR; changing a member's role/policy or adding/removing a gate is a P6
amendment recorded as a new ADR. Deliberate choice: SWC over the
default Vite/oxc test transform (decorator lowering). The Effect ecosystem was
removed entirely once the harness took the loop (ADR-0002) — domain logic is plain
TypeScript, biome is the primary linter (with a thin type-aware typescript-eslint
layer for the `no-unsafe-*` family), and the usage monoid is hand-written. OB1's
renderer is the core's own `formatEvent` over the trace event stream; ANSI styling
(`@effect/printer-ansi`) is deferred until structured logging is built out.
