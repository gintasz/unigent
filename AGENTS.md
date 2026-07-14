# Setup — do this FIRST in any fresh checkout or worktree
A new git worktree has **no `node_modules`**. Before editing, building, or committing, bootstrap it:

```bash
corepack pnpm install --frozen-lockfile
```

# Core vs. adapter
Unigent core MUST house all reusable language/runtime logic. Harness adapters and frontends (`@unigent/adapter-pi`, `@unigent/adapter-claude-cli`, `@unigent/adapter-codex-cli`, and `@unigent/cli`) contain only the minimum translation and presentation glue.

# Constitution
Read CONSTITUTION.md before starting any codebase changes or evaluations.

# Validation

When a code change is completed, always run full workspace tests, not just unit tests, not just package tests.

```bash
corepack pnpm run typecheck # types only, no tests
corepack pnpm test          # deterministic suite (unit + fake). Excludes e2e.
corepack pnpm run test:tui  # deterministic terminal rendering and 5,000-run stress suite
corepack pnpm run test:e2e  # real Pi, Claude CLI, and Codex CLI calls; requires local model authentication
corepack pnpm run build
corepack pnpm run check      # FAST static tier (typecheck, format, lint, lint:types, ast) — what pre-commit runs
corepack pnpm run check:full # FULL DoD gate (adds arch, spell, deps, dead, dup, build, api-surface, coverage) — what pre-push runs
```

Live E2E skips only when a backend is unavailable. A red authenticated run is a regression.
