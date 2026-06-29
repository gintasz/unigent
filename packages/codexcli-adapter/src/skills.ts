// Map a microfoom session's `skills` tri-state onto Codex. Codex has no per-run
// "disable all" or allow-list flag — skills are auto-discovered from a fixed set of
// roots and individually toggled via `[[skills.config]] { path, enabled }` entries.
// So we discover every SKILL.md under those roots ourselves and emit a per-skill
// `enabled = false` override (passed as `-c skills.config=[…]`) for the ones to drop:
//
//   - `skills` undefined → no override; Codex keeps all discovered skills (default).
//   - `skills` []        → disable every discovered skill.
//   - `skills` [a, b]    → disable every discovered skill except a, b (an allow-list).
//
// The mechanism is verified against the real CLI (a `-c skills.config` override with
// `enabled = false` drops the skill from the model's injected skill list).

import { type Dirent, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { FoomConfigError } from "@microfoom/core";

/** A discovered skill: its name (its directory name) and its SKILL.md path. */
type DiscoveredSkill = { readonly name: string; readonly path: string };

/** Bound the recursion: skills live at `<root>/<name>/SKILL.md` or one level deeper
 *  (e.g. Codex's bundled `<root>/.system/<name>/SKILL.md`). */
const MAX_DEPTH = 4;

/** Collect every `SKILL.md` path under `dir` (best-effort; a missing root is fine). */
function findSkillFiles(dir: string, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // root doesn't exist / not readable
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findSkillFiles(full, out, depth + 1);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      out.push(full);
    }
  }
}

/** The skill roots Codex scans, in the documented order: every `.agents/skills`
 *  from `workdir` up to the filesystem root, the user's `~/.agents/skills`, the
 *  Codex home's `skills` (including bundled `.system`), and `/etc/codex/skills`. */
function skillRoots(workdir: string): string[] {
  const roots: string[] = [];
  let cur = workdir;
  for (;;) {
    roots.push(join(cur, ".agents", "skills"));
    const parent = dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  roots.push(join(homedir(), ".agents", "skills"));
  // biome-ignore lint/style/noProcessEnv: CODEX_HOME is where the Codex CLI stores skills + sessions; reading it directly is the intent (not adapter config to route through an env module).
  roots.push(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "skills"));
  roots.push("/etc/codex/skills");
  return roots;
}

/** Discover every skill Codex would load for a run rooted at `workdir`. */
function discoverSkills(workdir: string): DiscoveredSkill[] {
  const files: string[] = [];
  for (const root of skillRoots(workdir)) {
    findSkillFiles(root, files);
  }
  const seen = new Set<string>();
  const out: DiscoveredSkill[] = [];
  for (const file of files) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    out.push({ name: basename(dirname(file)), path: file });
  }
  return out;
}

/**
 * Resolve which discovered skills to disable for a session's `skills` tri-state, or
 * `undefined` for "no override" (keep all). Throws {@link FoomConfigError} if an
 * allow-listed skill name isn't discovered (fail loud on a typo / missing skill).
 */
function skillsToDisable(
  discovered: readonly DiscoveredSkill[],
  skills: readonly string[] | undefined,
): readonly string[] | undefined {
  if (skills === undefined) {
    return;
  }
  if (skills.length === 0) {
    return discovered.map((skill) => skill.path);
  }
  const allow = new Set(skills);
  const names = new Set(discovered.map((skill) => skill.name));
  for (const want of allow) {
    if (!names.has(want)) {
      throw new FoomConfigError(
        `the codexcli harness cannot allow-list skill "${want}": no SKILL.md for it was found under any Codex skill root`,
      );
    }
  }
  return discovered.filter((skill) => !allow.has(skill.name)).map((skill) => skill.path);
}

export { discoverSkills, skillsToDisable };
