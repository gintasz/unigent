import {
  AgentBackendRejectedError,
  AgentBackendUnavailableError,
  AgentCancelledError,
  type BackendTool,
  type BackendTurnRequest,
} from "@unigent/core";
import { exerciseBackendContract } from "@unigent/test";
import { describe, expect, it } from "vitest";
import { type CodexProcess, type CodexProcessFactory, codexCli } from "../src/index.ts";

function lineProcess(lines: readonly string[]): CodexProcess {
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

function completed(sessionId: string, text: string): readonly string[] {
  return [
    JSON.stringify({ type: "thread.started", thread_id: sessionId }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }),
  ];
}

function request(tools: readonly BackendTool[] = []): BackendTurnRequest {
  return {
    systemPrompt: "UNIGENT SYSTEM",
    systemPromptMode: "replace",
    prompt: "do work",
    tools,
    signal: new AbortController().signal,
    onEvent: () => undefined,
  };
}

describe("Codex CLI backend integration", () => {
  it("satisfies the shared prose and fork contract", async () => {
    let turn = 0;
    const backend = codexCli({
      forkSession: () => "forked-session",
      processFactory: () => {
        turn += 1;
        return lineProcess(
          completed(turn === 1 ? "base-session" : "forked-session", `turn-${turn}`),
        );
      },
    });

    const result = await exerciseBackendContract(backend, "gpt-5.5-codex");

    expect(result).toMatchObject({ firstText: "turn-1", forkText: "turn-2" });
  });

  it("starts from clean Codex configuration and can disable native tools", async () => {
    let captured: readonly string[] = [];
    const factory: CodexProcessFactory = (args) => {
      captured = args;
      return lineProcess(completed("session-a", "ok"));
    };
    const backend = codexCli({ nativeTools: [], processFactory: factory });
    const session = await backend.openSession({ model: "gpt-5.5-codex" });

    await session.runTurn(request());

    expect(captured).toContain("--ignore-user-config");
    expect(captured).toContain("--ignore-rules");
    expect(captured).toContain("features.shell_tool=false");
    expect(captured).toContain('web_search="disabled"');
  });

  it("loads machine-mode developer instructions from an isolated profile", async () => {
    let captured: readonly string[] = [];
    let profile = "";
    const backend = codexCli({
      base: "machine",
      processFactory: (args, _signal, _prompt, environment) => {
        captured = args;
        const profileSetting = args.find((argument) => argument.startsWith("profile=")) ?? "";
        const profileName = JSON.parse(profileSetting.slice("profile=".length)) as string;
        profile = readFileSync(
          join(environment["CODEX_HOME"] ?? "", `${profileName}.config.toml`),
          "utf8",
        );
        return lineProcess(completed("session-profile", "ok"));
      },
    });
    const session = await backend.openSession({ model: "gpt-5.5-codex" });

    await session.runTurn({ ...request(), systemPromptMode: "append" });

    expect(captured.join(" ")).not.toContain("UNIGENT SYSTEM");
    expect(profile).toContain('developer_instructions = "UNIGENT SYSTEM"');
  });

  it("serves live Unigent closures through the Codex MCP endpoint", async () => {
    let executed: unknown;
    const finish: BackendTool = {
      name: "finish",
      description: "finish",
      parameters: { type: "object" },
      execute: async (input) => {
        executed = input;
        return { content: "accepted", isError: false, terminate: true };
      },
    };
    const backend = codexCli({
      processFactory: (args, _signal, prompt, environment) => {
        expect(prompt).toBe("do work");
        const authorization = `Bearer ${environment["UNIGENT_MCP_TOKEN"]}`;
        const mcpSetting = args.find((argument) => argument.startsWith("mcp_servers.unigent.url="));
        const mcpUrl = JSON.parse(
          (mcpSetting ?? "").slice("mcp_servers.unigent.url=".length),
        ) as string;
        return {
          lines: (async function* (): AsyncGenerator<string, void, undefined> {
            const initialized = await fetch(mcpUrl, {
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
            const sessionId = initialized.headers.get("mcp-session-id") ?? "";
            await fetch(mcpUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: authorization,
                "mcp-session-id": sessionId,
              },
              body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            });
            await fetch(mcpUrl, {
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
            yield* completed("session-b", "done");
          })(),
          stderr: () => "",
          completion: Promise.resolve({ exitCode: 0, signal: null }),
          kill: () => undefined,
        };
      },
    });
    const session = await backend.openSession({ model: "gpt-5.5-codex" });

    await session.runTurn(request([finish]));

    expect(executed).toEqual({ value: 9 });
  });

  it("marks cost reporting unsupported", async () => {
    const backend = codexCli({ processFactory: () => lineProcess(completed("unused", "unused")) });

    expect(backend.capabilities).toEqual({
      reportsCost: false,
      supportsSessionFork: true,
    });
  });

  it("kills the Codex process when stream consumption throws", async () => {
    let killed = false;
    const backend = codexCli({
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
    const session = await backend.openSession({ model: "gpt-5.5-codex" });

    await expect(session.runTurn(request())).rejects.toBeInstanceOf(AgentBackendUnavailableError);
    expect(killed).toBe(true);
  });

  it("reports direct-adapter cancellation with the cancellation taxonomy", async () => {
    const controller = new AbortController();
    const backend = codexCli({
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
    const session = await backend.openSession({ model: "gpt-5.5-codex" });

    const turn = session.runTurn({ ...request(), signal: controller.signal });
    controller.abort();

    await expect(turn).rejects.toBeInstanceOf(AgentCancelledError);
  });

  it("waits for process completion before classifying incompatible arguments", async () => {
    let stderr = "";
    const backend = codexCli({
      processFactory: () => ({
        lines: lineProcess([]).lines,
        stderr: () => stderr,
        completion: Promise.resolve().then(() => {
          stderr = "error: unexpected argument --new-flag\nUsage: codex exec";
          return { exitCode: 2, signal: null };
        }),
        kill: () => undefined,
      }),
    });
    const session = await backend.openSession({ model: "gpt-5.5-codex" });

    await expect(session.runTurn(request())).rejects.toBeInstanceOf(AgentBackendRejectedError);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
