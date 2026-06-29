// Tool-name namespacing, shared by harnesses that prefix MCP tool names. A harness
// shows the model a namespaced name (Claude Code → `mcp__<server>__<tool>`, OpenCode
// → `<server>_<tool>`) while the MCP server still routes by the CANONICAL basename.
// Core hard-codes the bare control-tool names in its tool descriptions, system
// prompt, and repair prompts, so the adapter — the sole author of the prefix — also
// rewrites every reference consistently. `makeNaming(style)` yields the three
// operations an adapter needs, so the regex/idempotency logic lives here once
// instead of being copied per adapter.

/** Which namespacing scheme a harness uses for MCP tool names. */
type NamingStyle = "bracket" | "underscore";

/** The naming operations an adapter applies to reconcile canonical ↔ model-visible
 *  tool names. */
interface ToolNaming {
  /** Canonical name → the model-visible (namespaced) name. */
  readonly prefixedToolName: (serverName: string, toolName: string) => string;
  /** Model-visible name → canonical (no-op for a never-namespaced built-in). */
  readonly stripPrefix: (serverName: string, name: string) => string;
  /** Rewrite every whole-word canonical tool name in `text` to its namespaced form. */
  readonly applyRename: (text: string, toolNames: readonly string[], serverName: string) => string;
}

/** The model-visible prefix for a server under a given style. */
function prefix(style: NamingStyle, serverName: string): string {
  return style === "bracket" ? `mcp__${serverName}__` : `${serverName}_`;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the tool-naming operations for a namespacing `style`.
 *
 * `applyRename` rewrites whole-word matches only (`\b` boundaries — underscore counts
 * as a word char, so a name already inside its prefixed form is not matched again,
 * making it idempotent) and sorts names longest-first so none partially matches
 * inside another.
 */
function makeNaming(style: NamingStyle): ToolNaming {
  const prefixedToolName = (serverName: string, toolName: string): string =>
    `${prefix(style, serverName)}${toolName}`;

  const stripPrefix = (serverName: string, name: string): string => {
    const head = prefix(style, serverName);
    return name.startsWith(head) ? name.slice(head.length) : name;
  };

  const applyRename = (text: string, toolNames: readonly string[], serverName: string): string => {
    let out = text;
    for (const name of [...toolNames].sort((a, b) => b.length - a.length)) {
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
      out = out.replace(pattern, prefixedToolName(serverName, name));
    }
    return out;
  };

  return { prefixedToolName, stripPrefix, applyRename };
}

export type { NamingStyle, ToolNaming };
export { makeNaming };
