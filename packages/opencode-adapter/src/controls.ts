// Internal: map a microfoom session's skills/plugins onto OpenCode session
// scoping. Not part of the public surface — consumed by createOpenCodeOpenSession
// (index.ts) and its unit test only.

import { FoomConfigError } from "@microfoom/core";

/** OpenCode session scoping derived from a microfoom session's skills/plugins. */
export interface OpenCodeSessionControls {
  /** Module ids to load via the config `plugin` array; absent = none. */
  readonly plugins?: readonly string[];
}

/**
 * Map a session's `skills`/`plugins` (opaque, tri-state — see core's `AgentConfig`)
 * onto OpenCode session controls. The session runs hermetic (the `skill` tool is
 * always disabled in the server config — both for safety and to skip OpenCode's
 * skill discovery scan), so these only ever turn chosen plugins ON.
 *
 *  - `plugins`: `undefined`/`[]` → no plugins; a list → the OpenCode `plugin`
 *    array, loading exactly those modules.
 *  - `skills`: `undefined` → OpenCode's default (the `skill` tool is off either
 *    way); `[]` → explicitly all skills off (the default). A by-name allow-list
 *    throws — OpenCode discovers skills from ambient config, so allowing only N
 *    would require enumerating every other skill to turn it off (unsupported here).
 */
export function buildSessionControls(
  skills: readonly string[] | undefined,
  plugins: readonly string[] | undefined,
): OpenCodeSessionControls {
  if (skills !== undefined && skills.length > 0) {
    throw new FoomConfigError(
      "the opencode harness cannot allow-list skills by name (OpenCode discovers skills from ambient config); use [] to disable all skills, or leave skills unset",
    );
  }
  return plugins !== undefined && plugins.length > 0 ? { plugins: [...plugins] } : {};
}
