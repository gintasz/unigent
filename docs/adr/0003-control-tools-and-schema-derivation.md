# ADR-0003: Structured completion and source-tool schema derivation

- **Status:** accepted (2026-06-26 · rewritten for Unigent 2026-07-13)
- **Date:** 2026-06-26
- **Constitution refs:** ID2, ID3, ID4, V4

## Context

Prose cannot reliably carry typed control. The agent may add markdown, explanation, or malformed
JSON. Tools also need provider-facing JSON Schema without forcing developers to duplicate their
TypeScript function signatures.

## Decision

Unigent uses reserved native tools for non-prose completion:

- `unigent_return` carries a schema-validated value or confirms `done`.
- `unigent_fail` is exposed only when the developer includes `fail`; it becomes
  `AgentRaisedError`.

The runtime never extracts those outcomes from text. Missing or invalid completion calls enter a
bounded repair loop.

An ordinary function becomes a tool only when listed in `AgentOptions.tools`. With
`source: import.meta.url`, Unigent reads the direct declaration, derives parameter JSON Schema
from its TypeScript signature, uses the JSDoc summary as its description, and reads optional
`@promptSnippet` and repeatable `@promptGuideline` tags. Unsupported signatures fail at setup.
The portable `tool({...})` form accepts an explicit Standard Schema when source is unavailable.

## Consequences

Structured results cannot be corrupted by surrounding prose. Source functions remain the single
source of truth for tool names, parameters, implementation, and prompt metadata. The core keeps a
runtime dependency on TypeScript and an internal JSON Schema validator.
