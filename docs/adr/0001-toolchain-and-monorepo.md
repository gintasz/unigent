# ADR-0001: Toolchain and monorepo layout

- **Status:** accepted (2026-06-26 · rewritten for Unigent 2026-07-13)
- **Date:** 2026-06-26
- **Constitution refs:** V1, V11, V13, ID4, ID7

## Context

Unigent publishes one batteries-included SDK and one CLI. The harness-neutral runtime, official
adapters, and deterministic test fixtures remain separate workspaces so their architectural
boundaries stay enforceable, but publishing each implementation package creates a noisy and
misleading npm surface. The core must stay usable inside the workspace without importing the
facade, any harness, or any frontend.

## Decision

Use a strict pnpm monorepo with lockstep versions.

The private root coordinator is named `@unigent/workspace`; the user-facing SDK is named
`@unigent/sdk`; the CLI is named `@unigent/cli`. Internal dependencies use `workspace:*` and are
bundled into the public package that consumes them.

- Private `@unigent/core` (`packages/unigent-core`) owns the backend port, tools, completion,
  checkpoints, arguments, errors, usage, trace model, and every reusable runtime policy.
- `@unigent/sdk` (`packages/unigent`) is the public facade. It bundles and re-exports the core, the
  three official adapter factories, and deterministic helpers under `@unigent/sdk/test`.
- `@unigent/adapter-pi`, `@unigent/adapter-claude-cli`, and `@unigent/adapter-codex-cli`
  are private and contain only backend translation.
- `@unigent/cli` owns process isolation and terminal presentation and bundles the private core.
- Private `@unigent/test` owns deterministic backend fixtures. `@unigent/e2e` remains private.
- Dependency direction is application/facade → adapter → core, while generic frontends and test
  fixtures depend directly on core. Core imports no facade or adapter; adapters import no facade.

TypeScript project references are build-authoritative. Public validation accepts Standard Schema;
the core may use an internal JSON Schema validator to execute derived source tools. Source-tool
schema derivation uses the TypeScript compiler API at runtime.

### Enforcement catalogue

| Role | Instance |
| --- | --- |
| formatter and primary linter | Biome |
| type-aware linter | typescript-eslint |
| code-pattern checker | ast-grep |
| import-graph checker | dependency-cruiser |
| type checker and builder | TypeScript project references |
| public-surface reporter | API Extractor |
| published-package validation | publint, Are the Types Wrong?, packed consumer smoke test |
| documentation checker | TypeDoc |
| deterministic test runner | Vitest |
| property testing | fast-check |
| dead code, duplication, dependency policy | knip, jscpd, syncpack |
| spelling and hooks | typos, lefthook |

## Consequences

Adding a backend does not change core. Official adapters are curated into the SDK; third-party
adapters depend on the public `Backend` contract exported by `@unigent/sdk`. Cross-package imports
go through package exports inside the workspace. The package contract rejects any public package
set other than `@unigent/sdk` and `@unigent/cli`. Tool swaps update this catalogue; changes to a
tool's architectural role require another ADR.
