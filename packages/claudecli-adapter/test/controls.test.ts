// Skills/plugins scoping: the tri-state config → Claude Code session controls
// (`enabledPlugins` via `--settings`, all-skills-off via `--disable-slash-commands`),
// the argv serialization, and the end-to-end wiring from run config to the spec.

import { FoomtimeConfigError, makeStandardSchema, Program, runProgram } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { buildSessionControls, createClaudeCliOpenSession } from "../src/index.ts";
import { buildArgs, type ClaudeProcessFactory, type ClaudeSpec } from "../src/process.ts";
import { fakeClaudeFactory } from "./support/fake_claude.ts";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);

const baseSpec: ClaudeSpec = {
  model: "sonnet",
  systemPrompt: "sys",
  prompt: "hi",
  mcpUrl: "http://localhost:1/mcp",
  serverName: "foom",
  foomTools: ["foom_return"],
  appendSystemPrompt: false,
};

describe("buildSessionControls (config → Claude settings)", () => {
  it("a plugins allow-list becomes enabledPlugins (each true)", () => {
    const controls = buildSessionControls(undefined, ["code-review@official", "lsp@official"]);
    expect(controls.settings).toEqual({
      enabledPlugins: { "code-review@official": true, "lsp@official": true },
    });
    expect(controls.disableSlashCommands).toBe(false);
  });

  it("plugins undefined or [] inject nothing (hermetic base = none)", () => {
    expect(buildSessionControls(undefined, undefined).settings).toBeUndefined();
    expect(buildSessionControls(undefined, []).settings).toBeUndefined();
  });

  it("skills:[] disables all skills; undefined leaves them", () => {
    expect(buildSessionControls([], undefined).disableSlashCommands).toBe(true);
    expect(buildSessionControls(undefined, undefined).disableSlashCommands).toBe(false);
  });

  it("a skills allow-list is unsupported and throws", () => {
    expect(() => buildSessionControls(["deploy"], undefined)).toThrow(FoomtimeConfigError);
  });
});

describe("buildArgs serialization", () => {
  it("emits --settings <json> when settings are present", () => {
    const settings = { enabledPlugins: { "p@m": true } };
    const args = buildArgs({ ...baseSpec, settings });
    const i = args.indexOf("--settings");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(args[i + 1] ?? "")).toEqual(settings);
  });

  it("emits --disable-slash-commands when asked, and neither flag by default", () => {
    expect(buildArgs({ ...baseSpec, disableSlashCommands: true })).toContain(
      "--disable-slash-commands",
    );
    const plain = buildArgs(baseSpec);
    expect(plain).not.toContain("--disable-slash-commands");
    expect(plain).not.toContain("--settings");
  });
});

describe("config reaches the claude subprocess (offline)", () => {
  function capturingHarness(): {
    openSession: ReturnType<typeof createClaudeCliOpenSession>;
    seen: () => ClaudeSpec | undefined;
  } {
    let captured: ClaudeSpec | undefined;
    const base = fakeClaudeFactory([{ kind: "text", text: "ok" }]);
    const factory: ClaudeProcessFactory = (spec) => {
      captured = spec;
      return base(spec);
    };
    return {
      openSession: createClaudeCliOpenSession({ processFactory: factory }),
      seen: () => captured,
    };
  }

  class Echo extends Program<typeof stringSchema, string>(stringSchema) {
    async main(): Promise<string> {
      return await this.agent.prose`hi`;
    }
  }

  it("a plugins allow-list arrives as enabledPlugins in the spec", async () => {
    const { openSession, seen } = capturingHarness();
    await runProgram(Echo, "x", {
      harnesses: { claudecli: openSession },
      model: "sonnet",
      defaults: { tools: [], plugins: ["code-review@official"] },
    });
    expect(seen()?.settings).toEqual({ enabledPlugins: { "code-review@official": true } });
    expect(seen()?.disableSlashCommands).toBe(false);
  });

  it("skills:[] sets disableSlashCommands on the spec", async () => {
    const { openSession, seen } = capturingHarness();
    await runProgram(Echo, "x", {
      harnesses: { claudecli: openSession },
      model: "sonnet",
      defaults: { tools: [], skills: [] },
    });
    expect(seen()?.disableSlashCommands).toBe(true);
  });

  it("a skills allow-list fails the run with FoomtimeConfigError", async () => {
    const { openSession } = capturingHarness();
    await expect(
      runProgram(Echo, "x", {
        harnesses: { claudecli: openSession },
        model: "sonnet",
        defaults: { tools: [], skills: ["deploy"] },
      }),
    ).rejects.toBeInstanceOf(FoomtimeConfigError);
  });
});
