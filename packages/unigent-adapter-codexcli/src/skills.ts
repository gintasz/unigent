import { type Dirent, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { AgentConfigError } from "@unigent/core";

/** One Codex skill available to a run. */
interface CodexSkill {
  readonly name: string;
  readonly path: string;
}

const MAX_DEPTH = 4;

function findSkillFiles(directory: string, files: string[], depth = 0): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      findSkillFiles(path, files, depth + 1);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(path);
    }
  }
}

function skillRoots(workdir: string): readonly string[] {
  const roots: string[] = [];
  let current = workdir;
  for (;;) {
    roots.push(join(current, ".agents", "skills"));
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  roots.push(join(homedir(), ".agents", "skills"));
  // biome-ignore lint/style/noProcessEnv: CODEX_HOME defines the CLI's own skill root.
  roots.push(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "skills"));
  roots.push("/etc/codex/skills");
  return roots;
}

/** Discover Codex skills from the documented workspace, user, and system roots. */
function discoverCodexSkills(workdir: string): readonly CodexSkill[] {
  const files: string[] = [];
  for (const root of skillRoots(workdir)) {
    findSkillFiles(root, files);
  }
  return [...new Set(files)].map((path) => ({ name: basename(dirname(path)), path }));
}

/** Resolve exact skill selection into Codex per-skill disable paths. */
function disabledSkillPaths(
  discovered: readonly CodexSkill[],
  selected: readonly string[] | undefined,
): readonly string[] | undefined {
  if (selected === undefined) {
    return;
  }
  if (selected.length === 0) {
    return discovered.map((skill) => skill.path);
  }
  const selectedNames = new Set(selected);
  const knownNames = new Set(discovered.map((skill) => skill.name));
  for (const name of selectedNames) {
    if (!knownNames.has(name)) {
      throw new AgentConfigError(`Codex skill is not installed: ${name}`);
    }
  }
  return discovered.filter((skill) => !selectedNames.has(skill.name)).map((skill) => skill.path);
}

export type { CodexSkill };
export { disabledSkillPaths, discoverCodexSkills };
