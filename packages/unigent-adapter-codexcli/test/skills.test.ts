import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disabledSkillPaths, discoverCodexSkills } from "../src/skills.ts";

const UNKNOWN_SKILL = /Codex skill is not installed: missing/;

let root: string;
let workdir: string;
let priorHome: string | undefined;
let priorCodexHome: string | undefined;

function createSkill(directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), "# skill");
}

beforeEach(() => {
  priorHome = process.env["HOME"];
  priorCodexHome = process.env["CODEX_HOME"];
  root = mkdtempSync(join(tmpdir(), "unigent-codex-skills-"));
  workdir = join(root, "work");
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  process.env["HOME"] = home;
  process.env["CODEX_HOME"] = codexHome;
  createSkill(join(workdir, ".agents", "skills", "local"));
  createSkill(join(home, ".agents", "skills", "user"));
  createSkill(join(codexHome, "skills", ".system", "bundled"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (priorHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env["HOME"] = priorHome;
  }
  if (priorCodexHome === undefined) {
    Reflect.deleteProperty(process.env, "CODEX_HOME");
  } else {
    process.env["CODEX_HOME"] = priorCodexHome;
  }
});

describe("Codex skill configuration", () => {
  it("discovers local, user, and Codex-home skills", () => {
    expect(
      discoverCodexSkills(workdir)
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(["bundled", "local", "user"]);
  });

  it("turns an allowlist into exact disabled paths", () => {
    const discovered = discoverCodexSkills(workdir);

    expect(disabledSkillPaths(discovered, undefined)).toBeUndefined();
    expect(disabledSkillPaths(discovered, [])).toHaveLength(3);
    expect(disabledSkillPaths(discovered, ["local"])).toHaveLength(2);
    expect(() => disabledSkillPaths(discovered, ["missing"])).toThrow(UNKNOWN_SKILL);
  });
});
