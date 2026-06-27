# Core vs. Extension
To support future agent harnesses, microfoom core MUST house all reusable language/runtime logic, while extensions (like pi-microfoom) contain only the bare minimum glue code.

# Constitution
Read CONSTITUTION.md before starting any codebase changes or evaluations.

# Validation

When a change is completed, always run full workspace tests, not just unit tests, not just package tests.

```bash
pnpm run typecheck # types only, no tests
pnpm test          # deterministic suite (unit + faux). Excludes e2e.
pnpm run test:e2e  # real-LLM e2e (dev machine must have model auth). Logs every run to /tmp/microfoom/e2e-<date>.log
pnpm run build
pnpm run check     # full DoD gate (typecheck, format, lint, arch, ast, spell, deps, dead, dup, build, api-surface, test)
```

e2e skips (not fails) on provider/connection errors — red there means a real regression. The log shows why each call ended.

