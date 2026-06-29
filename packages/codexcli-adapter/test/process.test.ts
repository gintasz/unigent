// The argv mapping: prove a fresh turn uses `codex exec`, a continued turn uses
// `codex exec resume <id>`, the hermetic/sandbox/mcp flags are always present, the
// prompt is the trailing positional, and the reasoning effort is passed only when
// valid.

import { describe, expect, it } from "vitest";
import { buildArgs, type CodexSpec } from "../src/process.ts";

const base: CodexSpec = {
  model: "gpt-5-codex",
  systemPrompt: "be a dispatcher",
  prompt: "do the thing",
  mcpUrl: "http://127.0.0.1:5555/mcp",
  serverName: "foom",
  workdir: "/work/dir",
};

const INSTR = "/tmp/instr.md";

describe("buildArgs", () => {
  it("builds a fresh `exec` invocation with hermetic + sandbox + mcp flags", () => {
    const args = buildArgs(base, INSTR);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain(`model_instructions_file="${INSTR}"`);
    expect(args).toContain('mcp_servers.foom.url="http://127.0.0.1:5555/mcp"');
    // model is a flag/value pair; cwd is set via the child process, not argv (the
    // `exec resume` subcommand rejects `-C`)
    expect(args).not.toContain("-C");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5-codex");
    // prompt is the trailing positional
    expect(args.at(-1)).toBe("do the thing");
    expect(args).not.toContain("resume");
  });

  it("builds a `exec resume <id>` invocation for a continued turn", () => {
    const args = buildArgs({ ...base, resumeSessionId: "thr_abc" }, INSTR);
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    // session id then prompt are the two trailing positionals, in that order
    expect(args.at(-2)).toBe("thr_abc");
    expect(args.at(-1)).toBe("do the thing");
  });

  it("passes a valid reasoning effort and drops an invalid one", () => {
    expect(buildArgs({ ...base, effort: "high" }, INSTR)).toContain(
      'model_reasoning_effort="high"',
    );
    const dropped = buildArgs({ ...base, effort: "bogus" }, INSTR);
    expect(dropped.some((a) => a.startsWith("model_reasoning_effort"))).toBe(false);
  });

  it("emits skills.config disable entries when skillDisablePaths is set", () => {
    const args = buildArgs(
      { ...base, skillDisablePaths: ["/s/a/SKILL.md", "/s/b/SKILL.md"] },
      INSTR,
    );
    expect(args).toContain(
      'skills.config=[{path="/s/a/SKILL.md",enabled=false},{path="/s/b/SKILL.md",enabled=false}]',
    );
  });

  it("omits skills.config when no skills are disabled", () => {
    expect(buildArgs(base, INSTR).some((a) => a.startsWith("skills.config"))).toBe(false);
    expect(
      buildArgs({ ...base, skillDisablePaths: [] }, INSTR).some((a) =>
        a.startsWith("skills.config"),
      ),
    ).toBe(false);
  });

  it("appends extra args before the prompt", () => {
    const args = buildArgs({ ...base, extraArgs: ["--flag"] }, INSTR);
    expect(args).toContain("--flag");
    expect(args.at(-1)).toBe("do the thing");
  });
});
