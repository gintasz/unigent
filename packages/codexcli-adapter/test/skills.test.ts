// Skills tri-state: prove discovery finds SKILL.md across the workdir-local,
// user, and Codex-home roots, and that skillsToDisable maps undefined/[]/allow-list
// to the right disable set (throwing on an unknown allow-listed skill). Driven
// against temp HOME + CODEX_HOME so it never touches the real skill roots.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, skillsToDisable } from "../src/skills.ts";

const UNKNOWN = /cannot allow-list skill "nope"/;

let work: string;
let prevHome: string | undefined;
let prevCodex: string | undefined;

function mkSkill(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# skill");
}

beforeEach(() => {
  prevHome = process.env["HOME"];
  prevCodex = process.env["CODEX_HOME"];
  const baseRoot = mkdtempSync(join(tmpdir(), "codex-skills-"));
  const home = join(baseRoot, "home");
  const codexHome = join(baseRoot, "codex");
  work = join(baseRoot, "work");
  process.env["HOME"] = home;
  process.env["CODEX_HOME"] = codexHome;
  mkSkill(join(work, ".agents", "skills", "alpha")); // workdir-local root
  mkSkill(join(home, ".agents", "skills", "beta")); // user root
  mkSkill(join(codexHome, "skills", ".system", "gamma")); // Codex bundled root
});

afterEach(() => {
  if (prevHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env["HOME"] = prevHome;
  }
  if (prevCodex === undefined) {
    Reflect.deleteProperty(process.env, "CODEX_HOME");
  } else {
    process.env["CODEX_HOME"] = prevCodex;
  }
});

describe("discoverSkills", () => {
  it("finds skills across workdir-local, user, and codex-home roots", () => {
    const names = discoverSkills(work)
      .map((skill) => skill.name)
      .sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("skillsToDisable", () => {
  it("returns undefined for an unset tri-state (keep all)", () => {
    expect(skillsToDisable(discoverSkills(work), undefined)).toBeUndefined();
  });

  it("disables every skill for []", () => {
    const disabled = skillsToDisable(discoverSkills(work), []);
    expect(disabled).toHaveLength(3);
  });

  it("disables everything except an allow-list", () => {
    const discovered = discoverSkills(work);
    const disabled = skillsToDisable(discovered, ["alpha"]);
    const alphaPath = discovered.find((skill) => skill.name === "alpha")?.path;
    expect(disabled).toHaveLength(2);
    expect(disabled).not.toContain(alphaPath);
  });

  it("throws on an unknown allow-listed skill", () => {
    expect(() => skillsToDisable(discoverSkills(work), ["nope"])).toThrow(UNKNOWN);
  });
});
