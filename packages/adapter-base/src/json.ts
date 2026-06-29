// Structural JSON coercion helpers. A CLI harness reads untyped JSON off a
// subprocess stream (Claude Code's stream-json, Codex's exec JSONL); these narrow a
// decoded value to the shape a reader needs, defaulting safely on a mismatch so a
// malformed line can never throw mid-parse.

/** A raw decoded JSON object. Shapes are validated structurally as read. */
export type Json = Record<string, unknown>;

/** The value as an object, or undefined if it isn't one. */
export const asObject = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null ? (value as Json) : undefined;

/** The value as an array, or an empty array if it isn't one. */
export const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** The value as a number, or 0 if it isn't one. */
export const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

/** The value as a string, or undefined if it isn't one. */
export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
