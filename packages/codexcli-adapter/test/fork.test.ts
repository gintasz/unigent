// The rollout-file fork: prove forkRolloutSession finds a parent session by id,
// copies it to a fresh id, and rewrites the session_meta `id` + `cwd` — driven
// against a temp CODEX_HOME so it never touches the real one.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkRolloutSession } from "../src/fork.ts";

/** Hoisted so the assertion's regex isn't re-compiled per call (useTopLevelRegex). */
const NOT_FOUND = /not found/;

let home: string;
let prior: string | undefined;

beforeEach(() => {
  prior = process.env["CODEX_HOME"];
  home = mkdtempSync(join(tmpdir(), "codex-home-"));
  process.env["CODEX_HOME"] = home;
});

afterEach(() => {
  if (prior === undefined) {
    Reflect.deleteProperty(process.env, "CODEX_HOME");
  } else {
    process.env["CODEX_HOME"] = prior;
  }
});

function writeParent(id: string): void {
  const dir = join(home, "sessions", "2026", "06", "29");
  mkdirSync(dir, { recursive: true });
  const meta = {
    timestamp: "2026-06-29T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd: "/old/cwd", originator: "codex_exec" },
  };
  const turn = { type: "response_item", payload: { type: "message", role: "user" } };
  writeFileSync(
    join(dir, `rollout-2026-06-29T00-00-00-${id}.jsonl`),
    `${JSON.stringify(meta)}\n${JSON.stringify(turn)}\n`,
  );
}

describe("forkRolloutSession", () => {
  it("copies the parent rollout to a fresh id with rewritten meta", () => {
    writeParent("parent-0001");
    const newId = forkRolloutSession("parent-0001", "/new/cwd");

    expect(newId).not.toBe("parent-0001");
    const files = readdirSync(join(home, "sessions", "2026", "06", "29"));
    const branch = files.find((f) => f.includes(newId));
    expect(branch).toBeDefined();

    const content = readFileSync(
      join(home, "sessions", "2026", "06", "29", branch as string),
      "utf8",
    );
    const meta = JSON.parse(content.split("\n")[0] as string) as {
      payload: { id: string; cwd: string };
    };
    expect(meta.payload.id).toBe(newId);
    expect(meta.payload.cwd).toBe("/new/cwd");
    // the non-meta line is carried over unchanged (transcript preserved)
    expect(content).toContain('"response_item"');
  });

  it("throws when the parent session cannot be found", () => {
    expect(() => forkRolloutSession("missing", "/x")).toThrow(NOT_FOUND);
  });
});
