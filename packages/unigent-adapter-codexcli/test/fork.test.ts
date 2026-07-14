import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkCodexSession } from "../src/fork.ts";

const NOT_FOUND = /rollout was not found/;

let home: string;
let priorCodexHome: string | undefined;

beforeEach(() => {
  priorCodexHome = process.env["CODEX_HOME"];
  home = mkdtempSync(join(tmpdir(), "unigent-codex-home-"));
  process.env["CODEX_HOME"] = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (priorCodexHome === undefined) {
    Reflect.deleteProperty(process.env, "CODEX_HOME");
  } else {
    process.env["CODEX_HOME"] = priorCodexHome;
  }
});

function writeParentSession(id: string, metadataFirst = true): void {
  const directory = join(home, "sessions", "2026", "07", "13");
  mkdirSync(directory, { recursive: true });
  const meta = {
    timestamp: "2026-07-13T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd: "/old/cwd", originator: "codex_exec" },
  };
  const turn = { type: "response_item", payload: { type: "message", role: "user" } };
  writeFileSync(
    join(directory, "rollout-with-format-independent-name.jsonl"),
    `${(metadataFirst ? [meta, turn] : [turn, meta]).map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

describe("Codex persisted-session fork", () => {
  it("copies the rollout to a fresh id while preserving its transcript", () => {
    writeParentSession("parent-0001");

    const childId = forkCodexSession("parent-0001", "/new/cwd");

    expect(childId).not.toBe("parent-0001");
    const directory = join(home, "sessions", "2026", "07", "13");
    const child = readdirSync(directory).find((file) => file.includes(childId));
    expect(child).toBeDefined();
    const content = readFileSync(join(directory, child ?? ""), "utf8");
    const meta = JSON.parse(content.split("\n")[0] ?? "") as {
      readonly payload: { readonly id: string; readonly cwd: string };
    };
    expect(meta.payload).toMatchObject({ id: childId, cwd: "/new/cwd" });
    expect(content).toContain('"response_item"');
  });

  it("rejects a missing parent session", () => {
    expect(() => forkCodexSession("missing", "/new/cwd")).toThrow(NOT_FOUND);
  });

  it("finds and patches session metadata without relying on filename or first-line format", () => {
    writeParentSession("parent-format-change", false);

    const childId = forkCodexSession("parent-format-change", "/new/cwd");

    const directory = join(home, "sessions", "2026", "07", "13");
    const child = readdirSync(directory).find((file) => file.includes(childId));
    const content = readFileSync(join(directory, child ?? ""), "utf8");
    expect(content).toContain(`"id":"${childId}"`);
    expect(content).not.toContain('"id":"parent-format-change"');
  });
});
