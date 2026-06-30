// Skills/plugins scoping: the tri-state config → OpenCode session controls, and the
// end-to-end wiring from run config to the spawned child's config.

import { makeStandardSchema, Program, runProgram } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import type { OpenCodeBackend, OpenCodeBackendFactory, OpenCodeConfig } from "../src/backend.ts";
import { buildSessionControls } from "../src/controls.ts";
import { createOpenCodeOpenSession } from "../src/index.ts";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);

describe("buildSessionControls (config → opencode controls)", () => {
  it("a plugins allow-list becomes the plugin module list", () => {
    expect(buildSessionControls(undefined, ["@scope/a", "@scope/b"]).plugins).toEqual([
      "@scope/a",
      "@scope/b",
    ]);
  });

  it("plugins undefined or [] add nothing", () => {
    expect(buildSessionControls(undefined, undefined).plugins).toBeUndefined();
    expect(buildSessionControls(undefined, []).plugins).toBeUndefined();
  });

  it("skills undefined or [] yield no allow-list (skill tool stays off)", () => {
    expect(buildSessionControls(undefined, undefined).skillPermission).toBeUndefined();
    expect(buildSessionControls([], undefined).skillPermission).toBeUndefined();
  });

  it("a skills allow-list allows the named skills and denies the rest", () => {
    expect(buildSessionControls(["deploy", "review"], undefined).skillPermission).toEqual({
      "*": "deny",
      deploy: "allow",
      review: "allow",
    });
  });
});

describe("config reaches the opencode child (offline)", () => {
  function capturingHarness(): {
    openSession: ReturnType<typeof createOpenCodeOpenSession>;
    seen: () => OpenCodeConfig | undefined;
  } {
    let captured: OpenCodeConfig | undefined;
    const factory: OpenCodeBackendFactory = ({ config }) => {
      captured = config;
      const backend: OpenCodeBackend = {
        createSession: async () => "s",
        forkSession: async () => "s-fork",
        prompt: async (_id, spec) => {
          // exercise the MCP server so the run can complete
          const mcp = config["mcp"] as Record<string, { url: string }>;
          const url = mcp[spec.serverName]?.url ?? "";
          await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          });
          return {
            assistantText: "ok",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
        close: async () => {
          /* capturing backend: nothing to close */
        },
      };
      return Promise.resolve(backend);
    };
    return {
      openSession: createOpenCodeOpenSession({ backendFactory: factory }),
      seen: () => captured,
    };
  }

  class Echo extends Program<typeof stringSchema, string>(stringSchema) {
    async main(): Promise<string> {
      return await this.agent.prose`hi`;
    }
  }

  it("a plugins allow-list arrives as the plugin array in the config", async () => {
    const { openSession, seen } = capturingHarness();
    await runProgram(Echo, "x", {
      harnesses: { opencode: openSession },
      model: "openrouter/x/y",
      defaults: { tools: [], plugins: ["@scope/a"] },
    });
    expect(seen()?.["plugin"]).toEqual(["@scope/a"]);
  });

  it("the hermetic baseline disables the skill tool and sharing", async () => {
    const { openSession, seen } = capturingHarness();
    await runProgram(Echo, "x", {
      harnesses: { opencode: openSession },
      model: "openrouter/x/y",
      defaults: { tools: [] },
    });
    expect(seen()?.["tools"]).toMatchObject({ skill: false });
    expect(seen()?.["share"]).toBe("disabled");
  });

  it("a skills allow-list reaches the child as permission.skill + an enabled skill tool", async () => {
    const { openSession, seen } = capturingHarness();
    await runProgram(Echo, "x", {
      harnesses: { opencode: openSession },
      model: "openrouter/x/y",
      defaults: { tools: [], skills: ["deploy"] },
    });
    const permission = seen()?.["permission"] as { skill?: Record<string, string> };
    expect(permission.skill).toEqual({ "*": "deny", deploy: "allow" });
    // with an allow-list the skill tool is left enabled (not forced off)
    const tools = seen()?.["tools"] as Record<string, boolean>;
    expect(tools["skill"]).toBeUndefined();
  });

  it("a requested thinking level becomes the model's reasoningEffort", async () => {
    const { openSession, seen } = capturingHarness();
    await runProgram(Echo, "x", {
      harnesses: { opencode: openSession },
      model: "openrouter/deepseek/deepseek-v4-flash",
      defaults: { tools: [], thinking: "high" },
    });
    const provider = seen()?.["provider"] as Record<
      string,
      { models: Record<string, { options: { reasoningEffort: string } }> }
    >;
    const opts = provider["openrouter"]?.models["deepseek/deepseek-v4-flash"]?.options;
    expect(opts?.reasoningEffort).toBe("high");
  });

  it("no thinking → no provider reasoning override", async () => {
    const { openSession, seen } = capturingHarness();
    await runProgram(Echo, "x", {
      harnesses: { opencode: openSession },
      model: "openrouter/x/y",
      defaults: { tools: [] },
    });
    expect(seen()?.["provider"]).toBeUndefined();
  });
});
