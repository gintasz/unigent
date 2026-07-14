import process from "node:process";
import { describe, expect, it } from "vitest";
import { buildCodexArgs, type CodexTurnSpec, spawnCodex } from "../src/process.ts";

const base: CodexTurnSpec = {
  model: "gpt-5.5-codex",
  mcpUrl: "http://127.0.0.1:4000/mcp",
  clean: true,
  disableNativeTools: false,
  instructionsFile: "/tmp/unigent-instructions.md",
};

describe("Codex CLI argument mapping", () => {
  it("creates an isolated fresh exec with MCP and replacement instructions", () => {
    const args = buildCodexArgs(base);

    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain('mcp_servers.unigent.url="http://127.0.0.1:4000/mcp"');
    expect(args).toContain('mcp_servers.unigent.bearer_token_env_var="UNIGENT_MCP_TOKEN"');
    expect(args).toContain('model_instructions_file="/tmp/unigent-instructions.md"');
    expect(args.slice(-2)).toEqual(["--", "-"]);
  });

  it("never places inherited developer instructions in argv", () => {
    const { instructionsFile: _instructionsFile, ...inheritedBase } = base;
    const args = buildCodexArgs({
      ...inheritedBase,
      clean: false,
    });

    expect(args).not.toContain("--ignore-user-config");
    expect(args.join(" ")).not.toContain("Unigent system prompt");
  });

  it("disables Codex native shell and web search only when requested", () => {
    const args = buildCodexArgs({ ...base, disableNativeTools: true });

    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain('web_search="disabled"');
  });

  it("resumes the supplied session and applies valid optional controls", () => {
    const args = buildCodexArgs({
      ...base,
      resumeSessionId: "session-1",
      thinking: "high",
      disabledSkillPaths: ["/skills/a/SKILL.md"],
      extraArgs: ["--ephemeral"],
    });

    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('skills.config=[{path="/skills/a/SKILL.md",enabled=false}]');
    expect(args.slice(-3)).toEqual(["session-1", "--", "-"]);
  });

  it("can defer permissions to Codex CLI", () => {
    const args = buildCodexArgs({ ...base, permissions: "cli" });

    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("rejects unsupported thinking instead of silently dropping it", () => {
    expect(() => buildCodexArgs({ ...base, thinking: "impossible" })).toThrow(
      "unsupported Codex thinking level",
    );
  });

  it("honors a configured binary and bounds captured stderr", async () => {
    const child = spawnCodex(
      ["-e", "process.stderr.write('x'.repeat(100000))"],
      new AbortController().signal,
      "",
      {},
      process.execPath,
    );

    for await (const _line of child.lines) {
      // Drain stdout before checking process completion, matching the adapter lifecycle.
    }
    await child.completion;

    expect(child.stderr()).toHaveLength(65_536);
  });
});
