// The opencode E2EAdapter. `live` drives the real OpenCode agent (the user's
// providers) against a real model via `@opencode-ai/sdk`. `scripted` drives the
// SAME adapter — its rename, in-process MCP server, result parser, and session
// threading all run — but a fake OpenCode backend replays the fixture's neutral
// script against the live MCP server, so the suite is offline and deterministic.
// Constructed BARE for safety: the harness sends only microfoom's prompt and every
// run passes `allowedTools: []`, so OpenCode's own filesystem tools are never
// advertised.

import process from "node:process";
import { CONTROL_TOOLS } from "@microfoom/core";
import {
  createOpenCodeOpenSession,
  type OpenCodeBackend,
  type OpenCodeBackendFactory,
  type OpenCodeConfig,
} from "@microfoom/opencode-adapter";
import type { E2EAdapter, RunContext } from "./adapters.ts";
import type { ScriptStep } from "./script.ts";

const TERMINAL: ReadonlySet<string> = new Set([CONTROL_TOOLS.return, CONTROL_TOOLS.throw]);

function mcpUrlOf(config: OpenCodeConfig): string {
  const mcp = config["mcp"] as Record<string, { url?: string }> | undefined;
  const first = mcp === undefined ? undefined : Object.values(mcp)[0];
  if (first?.url === undefined) {
    throw new Error("opencode scripted backend: no mcp url in config");
  }
  return first.url;
}

async function mcpCall(
  url: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** A fake OpenCode backend replaying a neutral ScriptStep[] (shared cursor across
 *  the run's turns) against the adapter's real in-process MCP server. */
function scriptedBackendFactory(steps: readonly ScriptStep[]): OpenCodeBackendFactory {
  let cursor = 0;
  let rpcId = 4000;
  let counter = 0;
  return async ({ config }: { config: OpenCodeConfig }): Promise<OpenCodeBackend> => {
    const url = mcpUrlOf(config);
    const prompt: OpenCodeBackend["prompt"] = async (_sessionId, spec) => {
      rpcId += 1;
      await mcpCall(url, rpcId, "tools/list", {});
      let finalText = "";
      let callSeq = 0;
      while (cursor < steps.length) {
        const step = steps[cursor];
        cursor += 1;
        if (step === undefined) {
          break;
        }
        if (step.kind === "text" || step.kind === "delayText") {
          if (step.kind === "delayText") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, step.ms);
              timer.unref?.();
            });
          }
          finalText = step.text;
          break;
        }
        callSeq += 1;
        const callId = `call_${callSeq}`;
        spec.onEvent?.({ type: "tool_call", callId, name: step.name, args: step.args });
        rpcId += 1;
        const response = await mcpCall(url, rpcId, "tools/call", {
          name: step.name,
          arguments: step.args,
        });
        const result = (response["result"] ?? {}) as {
          content?: Array<{ text?: string }>;
          isError?: boolean;
        };
        const text = (result.content ?? []).map((part) => part.text ?? "").join("");
        spec.onEvent?.({
          type: "tool_result",
          callId,
          content: text,
          isError: result.isError === true,
        });
        if (TERMINAL.has(step.name)) {
          break;
        }
      }
      return {
        assistantText: finalText,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    };
    return {
      createSession: async () => {
        counter += 1;
        return `scripted-${counter}`;
      },
      forkSession: async (parentId: string) => `${parentId}-fork`,
      prompt,
      close: async () => {
        /* scripted backend: nothing to close */
      },
    };
  };
}

/** The opencode harness adapter, driven live and scripted. */
export function opencodeE2EAdapter(): E2EAdapter {
  // A capable, fast tool-caller by default: OpenCode spawns a server per turn, so a
  // model that one-shots the FOOM protocol (rather than repair-looping) keeps each
  // live fixture inside its timeout. Override with MICROFOOM_OPENCODE_MODEL.
  const liveModel =
    process.env["MICROFOOM_OPENCODE_MODEL"] ?? "openrouter/anthropic/claude-haiku-4.5";
  return {
    name: "opencode",
    live: {
      openSession: createOpenCodeOpenSession(),
      model: liveModel,
    },
    scripted(steps): RunContext {
      return {
        openSession: createOpenCodeOpenSession({ backendFactory: scriptedBackendFactory(steps) }),
        model: "openrouter/deepseek/deepseek-v4-flash",
      };
    },
  };
}
