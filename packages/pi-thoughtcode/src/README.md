# PI Thoughtcode Adapter Structure

This package contains PI-specific adapter code. Thoughtcode semantics, tool names,
tool schemas, prompt text, and reusable messages belong in `thoughtcode-core`.

## Folders

- `extension.ts`: PI extension registration, command registration, and system prompt hookup.
- `tools/`: PI tool definitions and subagent spawning.
- `runs/`: in-memory VIBECALL run store, progress updates, transcript updates, and child-session event parsing.
- `ui/`: VIBECALL render card and `/thoughtcode-inspect` overlay.
- `shared/`: small PI adapter helpers for display formatting and tool results.
- `types.ts`: shared PI adapter types.

## Flow

1. `createVibeCallTool` creates a run record and calls `runThoughtcodeSubagent`.
2. `runThoughtcodeSubagent` starts a nested PI session with `read`, `VIBECALL`, and `VIBERETURN`.
3. Child-session events update the run store through `runs/`.
4. The VIBECALL card and `/thoughtcode-inspect` read from the same run record.
5. `VIBERETURN` is a terminal response tool. Inside a subagent, it also passes its value back to the parent VIBECALL.
