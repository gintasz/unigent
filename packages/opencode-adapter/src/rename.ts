// The prefix reconciliation. OpenCode namespaces every MCP tool as
// `<server>_<tool>` (underscore, not Claude's `mcp__<server>__`), so the model
// never sees the bare control-tool names (`foom_return`, …) that core hard-codes
// in its tool descriptions and repair prompts. Core stays canonical and
// harness-agnostic; this adapter — the sole author of the prefix — also reverses
// it consistently across every string the model reads. The rewrite is data-driven
// (the exact set of advertised tool names, not a heuristic) so it can never touch
// unrelated text. OpenCode strips its own prefix before invoking the MCP server,
// so tools are still registered (and called) under their canonical basenames.

/** The OpenCode MCP tool-name prefix for a given server name. */
function mcpPrefix(serverName: string): string {
  return `${serverName}_`;
}

/** The model-visible name of a canonical tool once OpenCode namespaces it. */
function prefixedToolName(serverName: string, toolName: string): string {
  return `${mcpPrefix(serverName)}${toolName}`;
}

/** Strip the `<server>_` prefix back to the canonical name (no-op for a built-in
 *  tool that was never namespaced). */
function stripPrefix(serverName: string, name: string): string {
  const prefix = mcpPrefix(serverName);
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrite every whole-word occurrence of each canonical tool name in `text` to its
 * prefixed form. `\b` boundaries (underscore counts as a word char) mean a name
 * already inside its prefixed form — `foom_foom_return` — is NOT matched again (the
 * preceding `_` blocks the boundary), so the rewrite is idempotent. Names are
 * sorted longest-first so no name can partially match inside another.
 */
function applyRename(text: string, toolNames: readonly string[], serverName: string): string {
  let out = text;
  for (const name of [...toolNames].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    out = out.replace(pattern, prefixedToolName(serverName, name));
  }
  return out;
}

export { applyRename, prefixedToolName, stripPrefix };
