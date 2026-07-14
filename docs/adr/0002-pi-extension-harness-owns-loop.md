# ADR-0002: The backend owns the agent loop

- **Status:** accepted (2026-06-26 · rewritten for Unigent 2026-07-13)
- **Date:** 2026-06-26
- **Constitution refs:** ID2, ID7, V1, V3, V4

## Context

Pi, Claude CLI, and Codex CLI already own model iteration, native tool execution, transcript state,
and provider transport. Reimplementing an agent loop in Unigent would discard harness behavior and
force every adapter into an artificial token-stream interface.

## Decision

Each backend implements `Backend.openSession()`. A backend session receives a complete turn:
system prompt, user prompt, Unigent tools, thinking level, limits it can enforce, cancellation,
and an event sink. It resolves with final prose and normalized usage. Optional `fork()` preserves
the harness's native conversation semantics.

Unigent core owns everything reusable across harnesses: completion tools, source and portable
tools, repair, retries, limits, checkpoints, nested-run ancestry, usage folding, and tracing.
Adapters only translate this neutral turn to Pi, Claude CLI, or Codex CLI and normalize events back.

## Consequences

Harness-native behavior remains available without leaking vendor types into the facade. Missing
capabilities are declared and dependent configuration fails before a model call. Deterministic
tests drive the same core through `@unigent/test`.
