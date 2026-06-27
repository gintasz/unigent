# ADR-0001: Toolchain and monorepo layout

- **Status:** accepted (revised 2026-06-27: added `@microfoom/trace-view`)
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
  - `@microfoom/pi` (`packages/pi-microfoom`) — the reference harness over the
    `@earendil-works` pi agent (`pi-agent-core` `Agent`, `pi-coding-agent`
    ModelRegistry/AuthStorage, `pi-ai` providers). Thin glue; also ships the
    `/microfoom-run` pi extension and its TUI trace presentation.
  - `@microfoom/trace-view` (`packages/trace-view`) — frontend-neutral run-trace
    presentation: shapes a `@microfoom/core/trace` `RunNode` tree into ordered
    rows + the duration/token/cost metric strings, painting nothing. Shared by the
    CLI text panel and the pi TUI widget so the two surfaces never drift. Depends
    only on core (types); no harness, no UI library. This is the presentation
    boundary's neutral half — core stays paint-free (F8), each frontend owns its
    own paint (picocolors/log-update for the CLI; Box/Text + theme for pi).
  - `@microfoom/cli` (`packages/microfoom-cli`) — the `microfoom run` CLI
    frontend (live `log-update` panel + faux session). Depends on pi, core, and
    trace-view.
  - Dependency direction (A3): cli → {pi, core, trace-view}; pi → {core,
    trace-view}; trace-view → core (types only); core imports nothing downstream
    and no harness.
- **Build/types:** TypeScript strict + `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`;
  ESM, NodeNext; `tsc -b` project references are build-authoritative; ts-reset for
  a sound stdlib (T1).
- **Schema:** `@standard-schema/spec` only; no concrete validator is a library
  dependency (F4).
- **No Effect.** Domain logic is plain TypeScript; the usage monoid (OB3) is a
  small hand-written `combineUsage`/`emptyUsage` (its laws pinned by property
  tests). Effect-internal was dropped with ADR-0002; with `effect` gone, the
  `@effect/eslint-plugin` rule (which only guarded the `effect` barrel) and eslint
  itself were removed — biome is the sole linter.
- **Format/lint/arch:** biome (format + lint), dependency-cruiser (layer/import
  rules), ast-grep / `@ast-grep/cli` (in-file bans biome can't express),
  api-extractor (`.api.md` surface report).
- **Test:** vitest + fast-check (property-based), transformed by **SWC**
  (`unplugin-swc`) because the default Vite transform (oxc) does not lower the
  TC39 decorators that `@foom.config`/`@foom.expose` use.
- **Hygiene:** syncpack (one version per dep, exact), knip (dead code), jscpd
  (duplication), cspell, lefthook (DoD gate, git hooks).
- Package **directory** names are kebab-case (ecosystem norm); **source files**
  are snake_case (N1), enforced by biome's filename rule scoped to `packages/*/src`.

### Enforcement class → instance (resolves the constitution's class names)

| Constitution class | Instance | Rules |
| --- | --- | --- |
| formatter / linter | biome | B2, B7, L3, N1, N2 |
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
| spell checker | cspell (`project-words.txt`) | N5 |
| git-hook runner | lefthook | V1, DOD |
| usage-accounting monoid | hand-written `combineUsage`/`emptyUsage` (core) | OB3 |
| event renderer | core `formatEvent`/`consoleExporter` (`@microfoom/core/trace`) | OB1 |

## Consequences

Every gate runs locally (lefthook) and in CI before merge. Changing any toolchain
member is a P6 amendment recorded as a new ADR. Deliberate choice: SWC over the
default Vite/oxc test transform (decorator lowering). The Effect ecosystem was
removed entirely once the harness took the loop (ADR-0002) — domain logic is plain
TypeScript, biome is the only linter, and the usage monoid is hand-written. OB1's
renderer is the core's own `formatEvent` over the trace event stream; ANSI styling
(`@effect/printer-ansi`) is deferred until structured logging is built out.
