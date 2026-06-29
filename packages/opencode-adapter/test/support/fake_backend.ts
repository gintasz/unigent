// A fake OpenCode backend: replays a scripted model against the adapter's REAL
// in-process MCP server (over real localhost HTTP) and builds a real OpenCode-shaped
// `session.prompt` response, which the adapter parses with its real result reader.
// Only the model's decisions and the `opencode serve` child are faked — the MCP
// server, the prefix rename, the result parser, the usage mapping, and the session
// threading all run for real. This is the offline, deterministic seam (mirrors pi's
// faux provider and claudecli's fake `claude`).

import { CONTROL_TOOLS } from "@microfoom/core";
import type { OpenCodeBackend, OpenCodeBackendFactory, OpenCodeConfig } from "../../src/backend.ts";

/** One scripted model turn-step. */
type FakeStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "delayText"; readonly ms: number; readonly text: string }
  | { readonly kind: "toolCall"; readonly name: string; readonly args: Record<string, unknown> };

const TERMINAL: ReadonlySet<string> = new Set([CONTROL_TOOLS.return, CONTROL_TOOLS.throw]);

/** A token block shaped like OpenCode's, with a non-zero total so usage gates fire. */
const FAKE_INFO = {
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total: 2 },
  cost: 0,
};

/** Read the single MCP server URL out of the config the adapter built. */
function mcpUrlOf(config: OpenCodeConfig): string {
  const mcp = config["mcp"] as Record<string, { url?: string }> | undefined;
  const first = mcp === undefined ? undefined : Object.values(mcp)[0];
  if (first?.url === undefined) {
    throw new Error("fake backend: no mcp url in config");
  }
  return first.url;
}

/** POST one JSON-RPC message to the turn's MCP server and return its result. */
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

/**
 * Build a backend factory that replays `steps` across the run's turns (one shared
 * cursor, like the live model deciding turn by turn). Each backend instance (= one
 * turn) consumes steps until it ends the turn: a text reply, or a terminal
 * foom_return / foom_throw.
 */
function fakeBackendFactory(steps: readonly FakeStep[]): OpenCodeBackendFactory {
  let cursor = 0;
  let rpcId = 3000;
  let sessionCounter = 0;
  return async ({ config }: { config: OpenCodeConfig }): Promise<OpenCodeBackend> => {
    const mcpUrl = mcpUrlOf(config);

    const prompt: OpenCodeBackend["prompt"] = async (_sessionId, spec) => {
      rpcId += 1;
      await mcpCall(mcpUrl, rpcId, "tools/list", {});

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
        // Surface the tool call + result on the live stream, like the real backend,
        // so core's transcript (tool_start/tool_end) reflects the turn.
        callSeq += 1;
        const callId = `call_${callSeq}`;
        spec.onEvent?.({ type: "tool_call", callId, name: step.name, args: step.args });
        rpcId += 1;
        const response = await mcpCall(mcpUrl, rpcId, "tools/call", {
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

      const body = {
        data: { info: FAKE_INFO, parts: [{ type: "text", text: finalText }] },
      };
      const { readPromptResponse } = await import("../../src/result.ts");
      const outcome = readPromptResponse(body, spec.serverName, undefined);
      return outcome;
    };

    return {
      createSession: async () => {
        sessionCounter += 1;
        return `fake-session-${sessionCounter}`;
      },
      forkSession: async (parentId: string) => `${parentId}-fork`,
      prompt,
      close: async () => {
        /* fake backend: no child server to close */
      },
    };
  };
}

export type { FakeStep };
export { fakeBackendFactory };
