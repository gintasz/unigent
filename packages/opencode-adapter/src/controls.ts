// Internal: map a microfoom session's skills/plugins onto OpenCode session
// scoping. Not part of the public surface — consumed by createOpenCodeOpenSession
// (index.ts) and its unit test only.

/** OpenCode session scoping derived from a microfoom session's skills/plugins. */
export interface OpenCodeSessionControls {
  /** Module ids to load via the config `plugin` array; absent = none. */
  readonly plugins?: readonly string[];
  /** Per-skill permission map for the config `permission.skill` allow-list
   *  (`{ name: "allow", …, "*": "deny" }`); absent = no skills allow-list. */
  readonly skillPermission?: Readonly<Record<string, "allow" | "deny">>;
}

/**
 * Map a session's `skills`/`plugins` (opaque, tri-state — see core's `AgentConfig`)
 * onto OpenCode session controls.
 *
 *  - `plugins`: `undefined`/`[]` → no plugins; a list → the OpenCode `plugin`
 *    array, loading exactly those modules.
 *  - `skills`: `undefined`/`[]` → no allow-list (the `skill` tool stays disabled in
 *    the server config — hermetic default, also skips OpenCode's skill scan). A list
 *    → a `permission.skill` allow-list (`{ <each>: "allow", "*": "deny" }`) and the
 *    `skill` tool enabled, so only the named skills load. (A turn must also keep the
 *    `skill` tool in its `allowedTools` for the model to reach them.)
 */
export function buildSessionControls(
  skills: readonly string[] | undefined,
  plugins: readonly string[] | undefined,
): OpenCodeSessionControls {
  const base: OpenCodeSessionControls =
    plugins !== undefined && plugins.length > 0 ? { plugins: [...plugins] } : {};
  if (skills === undefined || skills.length === 0) {
    return base;
  }
  const skillPermission: Record<string, "allow" | "deny"> = { "*": "deny" };
  for (const name of skills) {
    skillPermission[name] = "allow";
  }
  return { ...base, skillPermission };
}
