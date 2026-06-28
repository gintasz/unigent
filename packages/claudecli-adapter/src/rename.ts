// The prefix reconciliation. Claude Code namespaces every MCP tool as
// `mcp__<server>__<tool>`, so the model never sees the bare control-tool names
// (`foom_return`, …) that core hard-codes in its tool descriptions and repair
// prompts. Core stays canonical and harness-agnostic; this adapter — the sole
// author of the prefix — also reverses it consistently across every string the
// model reads. The rewrite is data-driven (the exact set of advertised tool
// names, not a heuristic) so it can never touch unrelated text.

/** The Claude Code MCP tool-name prefix for a given server name. */
export function mcpPrefix(serverName: string): string {
  return `mcp__${serverName}__`;
}

/** The model-visible name of a canonical tool once Claude Code namespaces it. */
export function prefixedToolName(serverName: string, toolName: string): string {
  return `${mcpPrefix(serverName)}${toolName}`;
}

/** Strip the `mcp__<server>__` prefix back to the canonical name (no-op for a
 *  built-in tool that was never namespaced). */
export function stripPrefix(serverName: string, name: string): string {
  const prefix = mcpPrefix(serverName);
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrite every whole-word occurrence of each canonical tool name in `text` to its
 * prefixed form. `\b` boundaries (underscore counts as a word char) mean a name
 * already inside its prefixed form — `mcp__foom__foom_return` — is NOT matched
 * again (the preceding `_` blocks the boundary), so the rewrite is idempotent.
 * Names are sorted longest-first so no name can partially match inside another.
 */
export function applyRename(
  text: string,
  toolNames: readonly string[],
  serverName: string,
): string {
  let out = text;
  for (const name of [...toolNames].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    out = out.replace(pattern, prefixedToolName(serverName, name));
  }
  return out;
}
