import {
  AgentBackendRejectedError,
  AgentBackendUnavailableError,
  AgentCancelledError,
  AgentConfigError,
  type BackendTool,
  type BackendTurnRequest,
} from "@unigent/core";
import { exerciseBackendContract } from "@unigent/test";
import { describe, expect, it } from "vitest";
import {
  type ClaudeCliOptions,
  type ClaudeProcess,
  type ClaudeProcessFactory,
  claudeCli,
} from "../src/index.ts";

function lineProcess(lines: readonly string[]): ClaudeProcess {
  return {
    lines: (async function* (): AsyncGenerator<string, void, undefined> {
      for (const line of lines) {
        yield line;
      }
    })(),
    stderr: () => "",
    completion: Promise.resolve({ exitCode: 0, signal: null }),
    kill: () => undefined,
  };
}

async function* deferredLines(
  load: () => Promise<readonly string[]>,
): AsyncGenerator<string, void, undefined> {
  for (const line of await load()) {
    yield line;
  }
}

function completed(sessionId: string, text = "ok"): readonly string[] {
  return [
    JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: { content: [{ type: "text", text }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: text,
      usage: { input_tokens: 2, output_tokens: 1 },
      total_cost_usd: 0.01,
    }),
  ];
}

function request(tools: readonly BackendTool[] = []): BackendTurnRequest {
  return {
    systemPrompt: "UNIGENT",
    systemPromptMode: "append",
    prompt: "do work",
    tools,
    thinking: "high",
    signal: new AbortController().signal,
    onEvent: () => undefined,
  };
}

describe("Claude CLI backend integration", () => {
  it("satisfies the shared backend prose and fork contract", async () => {
    let turn = 0;
    const backend = claudeCli({
      processFactory: () => {
        turn += 1;
        return lineProcess(
          completed("contract-session", turn === 1 ? "contract-first" : "contract-fork"),
        );
      },
    });

    const result = await exerciseBackendContract(backend, "sonnet");

    expect(result).toMatchObject({ firstText: "contract-first", forkText: "contract-fork" });
  });

  it("starts clean by default and bypasses interactive permissions", async () => {
    let captured: readonly string[] = [];
    const factory: ClaudeProcessFactory = (args, _signal, prompt) => {
      expect(prompt).toBe("do work");
      captured = args;
      return lineProcess(completed("session-a"));
    };
    const backend = claudeCli({ processFactory: factory });
    const session = await backend.openSession({ model: "sonnet" });

    const result = await session.runTurn(request());

    expect(result.text).toBe("ok");
    expect(captured).toContain("--setting-sources");
    expect(captured).toContain("--strict-mcp-config");
    expect(captured).toContain("bypassPermissions");
    expect(captured).toContain("--disable-slash-commands");
    expect(captured).toContain("sonnet");
  });

  it("applies machine-base category overrides without persistent mutation", async () => {
    let captured: readonly string[] = [];
    const backend = claudeCli({
      base: "machine",
      nativeTools: [],
      mcpServers: [],
      plugins: ["selected@market"],
      skills: [],
      hooks: [],
      listPlugins: () => [
        { id: "selected@market", enabled: false },
        { id: "ambient@market", enabled: true },
      ],
      processFactory: (args) => {
        captured = args;
        return lineProcess(completed("session-b"));
      },
    });
    const session = await backend.openSession({ model: "opus" });

    await session.runTurn(request());

    const settingsIndex = captured.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(JSON.parse(captured[settingsIndex + 1] ?? "{}")).toEqual({
      disableAllHooks: true,
      enabledPlugins: {
        "selected@market": true,
        "ambient@market": false,
      },
    });
    expect(captured.slice(captured.indexOf("--tools"), captured.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ]);
    expect(captured).toContain("--strict-mcp-config");
  });

  it("serves live Unigent closures through MCP to the CLI process", async () => {
    let executed: unknown;
    let capturedToolSetting: readonly string[] = [];
    const finish: BackendTool = {
      name: "finish",
      description: "finish",
      parameters: { type: "object" },
      execute: async (input) => {
        executed = input;
        return { content: "done", isError: false, terminate: true };
      },
    };
    const factory: ClaudeProcessFactory = (args, _signal, prompt, environment) => {
      expect(prompt).toBe("do work");
      const authorization = `Bearer ${environment["UNIGENT_MCP_TOKEN"]}`;
      const toolsIndex = args.indexOf("--tools");
      capturedToolSetting = args.slice(toolsIndex, toolsIndex + 2);
      return {
        lines: (async function* (): AsyncGenerator<string, void, undefined> {
          const configIndex = args.indexOf("--mcp-config");
          const config = JSON.parse(args[configIndex + 1] ?? "{}") as {
            mcpServers: { unigent: { url: string } };
          };
          const initialized = await fetch(config.mcpServers.unigent.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: authorization,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "unigent-test", version: "0.1.0" },
              },
            }),
          });
          expect(initialized.ok).toBe(true);
          const sessionId = initialized.headers.get("mcp-session-id") ?? "";
          await fetch(config.mcpServers.unigent.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: authorization,
              "mcp-session-id": sessionId,
            },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          });
          const rpc = await fetch(config.mcpServers.unigent.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: authorization,
              "mcp-session-id": sessionId,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "finish", arguments: { value: 9 } },
            }),
          });
          if (!rpc.ok) {
            throw new Error(`MCP call failed (${rpc.status}): ${await rpc.text()}`);
          }
          yield* completed("session-c");
        })(),
        stderr: () => "",
        completion: Promise.resolve({ exitCode: 0, signal: null }),
        kill: () => undefined,
      };
    };
    const backend = claudeCli({ nativeTools: [], processFactory: factory });
    const session = await backend.openSession({ model: "sonnet" });

    await session.runTurn(request([finish]));

    expect(executed).toEqual({ value: 9 });
    expect(capturedToolSetting).toEqual(["--tools", "ToolSearch"]);
  });

  it("resumes and forks Claude session ids", async () => {
    const invocations: Array<readonly string[]> = [];
    const backend = claudeCli({
      processFactory: (args) => {
        invocations.push(args);
        return lineProcess(completed("stable-session"));
      },
    });
    const base = await backend.openSession({ model: "sonnet" });
    await base.runTurn(request());
    const branch = base.fork?.();

    await branch?.runTurn(request());

    expect(invocations[1]).toContain("--resume");
    expect(invocations[1]).toContain("--fork-session");
  });

  it("changes the allowed tool surface between resumed Claude turns", async () => {
    const invocations: Array<readonly string[]> = [];
    const finish: BackendTool = {
      name: "finish",
      description: "finish",
      parameters: { type: "object" },
      execute: async () => ({ content: "accepted", isError: false }),
    };
    const backend = claudeCli({
      processFactory: (args) => {
        invocations.push(args);
        return lineProcess(completed("alternating-session"));
      },
    });
    const session = await backend.openSession({ model: "sonnet" });

    await session.runTurn(request());
    await session.runTurn(request([finish]));
    await session.runTurn(request());

    const allowedTools = invocations.map((args) => args[args.indexOf("--allowedTools") + 1]);
    expect(allowedTools).toEqual(["", "mcp__unigent__finish", ""]);
    expect(invocations[1]).toContain("--resume");
    expect(invocations[2]).toContain("--resume");
  });

  it("rejects backend controls Claude CLI cannot enforce", () => {
    const invalidSkills: unknown = { skills: ["one-skill"] };
    const invalidHooks: unknown = { hooks: ["one-hook"] };
    const invalidMcp: unknown = { mcpServers: ["one-server"] };
    expect(() => claudeCli(invalidSkills as ClaudeCliOptions)).toThrow(AgentConfigError);
    expect(() => claudeCli(invalidHooks as ClaudeCliOptions)).toThrow(AgentConfigError);
    expect(() => claudeCli(invalidMcp as ClaudeCliOptions)).toThrow(AgentConfigError);
  });

  it("fails closed when exact plugin selection cannot enumerate installed plugins", async () => {
    const backend = claudeCli({
      base: "machine",
      plugins: [],
      listPlugins: () => {
        throw new Error("plugin command failed");
      },
      processFactory: () => lineProcess(completed("unused")),
    });
    const session = await backend.openSession({ model: "sonnet" });

    await expect(session.runTurn(request())).rejects.toThrow(
      "unable to enumerate installed Claude plugins",
    );
  });

  it("enumerates installed plugins asynchronously once per backend", async () => {
    let listings = 0;
    const backend = claudeCli({
      plugins: [],
      listPlugins: async () => {
        listings += 1;
        await Promise.resolve();
        return [];
      },
      processFactory: () => lineProcess(completed("cached-plugins")),
    });
    const session = await backend.openSession({ model: "sonnet" });

    await session.runTurn(request());
    await session.runTurn(request());

    expect(listings).toBe(1);
  });

  it("can leave permissions to Claude CLI and rejects unknown thinking levels", async () => {
    let captured: readonly string[] = [];
    const backend = claudeCli({
      permissions: "cli",
      processFactory: (args) => {
        captured = args;
        return lineProcess(completed("permission-session"));
      },
    });
    const session = await backend.openSession({ model: "sonnet" });
    const { thinking: _thinking, ...withoutThinking } = request();

    await session.runTurn(withoutThinking);

    expect(captured).not.toContain("--permission-mode");
    await expect(session.runTurn({ ...request(), thinking: "impossible" })).rejects.toBeInstanceOf(
      AgentConfigError,
    );
  });

  it("kills the Claude process when stream consumption throws", async () => {
    let killed = false;
    const backend = claudeCli({
      processFactory: () => ({
        lines: deferredLines(async () => {
          throw new Error("broken stdout pipe");
        }),
        stderr: () => "",
        completion: Promise.resolve({ exitCode: 1, signal: null }),
        kill: () => {
          killed = true;
        },
      }),
    });
    const session = await backend.openSession({ model: "sonnet" });

    await expect(session.runTurn(request())).rejects.toBeInstanceOf(AgentBackendUnavailableError);
    expect(killed).toBe(true);
  });

  it("reports direct-adapter cancellation with the cancellation taxonomy", async () => {
    const controller = new AbortController();
    const backend = claudeCli({
      processFactory: (_args, signal) => {
        const aborted = new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {
          lines: deferredLines(async () => {
            await aborted;
            return [];
          }),
          stderr: () => "",
          completion: aborted.then(() => ({ exitCode: null, signal: "SIGTERM" as const })),
          kill: () => undefined,
        };
      },
    });
    const session = await backend.openSession({ model: "sonnet" });

    const turn = session.runTurn({ ...request(), signal: controller.signal });
    controller.abort();

    await expect(turn).rejects.toBeInstanceOf(AgentCancelledError);
  });

  it("waits for process completion before classifying incompatible arguments", async () => {
    let stderr = "";
    const backend = claudeCli({
      processFactory: () => ({
        lines: lineProcess([]).lines,
        stderr: () => stderr,
        completion: Promise.resolve().then(() => {
          stderr = "error: unknown option --new-flag\nUsage: claude";
          return { exitCode: 2, signal: null };
        }),
        kill: () => undefined,
      }),
    });
    const session = await backend.openSession({ model: "sonnet" });

    await expect(session.runTurn(request())).rejects.toBeInstanceOf(AgentBackendRejectedError);
  });
});
