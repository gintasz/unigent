// Internal: map a microfoom session's skills/plugins onto Claude Code session
// scoping. Not part of the public surface — consumed by createClaudeCliOpenSession
// (index.ts) and its unit test only.

import { FoomConfigError } from "@microfoom/core";

/** Claude Code session scoping derived from a microfoom session's skills/plugins. */
export interface ClaudeSessionControls {
  /** Settings to inject via `--settings` (e.g. `enabledPlugins`); absent = none. */
  readonly settings?: Record<string, unknown>;
  /** Disable ALL skills (`--disable-slash-commands`). */
  readonly disableSlashCommands: boolean;
}

/**
 * Map a session's `skills`/`plugins` (opaque, tri-state — see core's `AgentConfig`)
 * onto Claude Code session controls. The session runs hermetic
 * (`--setting-sources ""`), so nothing is enabled by ambient config; these only ever
 * turn chosen plugins ON and skills OFF.
 *
 *  - `plugins`: `undefined`/`[]` → no plugins (the hermetic default); a list →
 *    `enabledPlugins` enabling exactly those (ids are Claude's `name@marketplace`).
 *  - `skills`: `undefined` → Claude's default skills; `[]` → all skills off. A
 *    by-name allow-list throws — Claude skills default to "on", so allowing only N
 *    would require enumerating every skill to turn the rest off (unsupported here).
 */
export function buildSessionControls(
  skills: readonly string[] | undefined,
  plugins: readonly string[] | undefined,
): ClaudeSessionControls {
  const settings: Record<string, unknown> = {};
  if (plugins !== undefined && plugins.length > 0) {
    settings["enabledPlugins"] = Object.fromEntries(plugins.map((id) => [id, true]));
  }
  let disableSlashCommands = false;
  if (skills !== undefined) {
    if (skills.length === 0) {
      disableSlashCommands = true;
    } else {
      throw new FoomConfigError(
        "the claudecli harness cannot allow-list skills by name (Claude Code skills default to on); use [] to disable all skills, or leave skills unset",
      );
    }
  }
  return {
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    disableSlashCommands,
  };
}
