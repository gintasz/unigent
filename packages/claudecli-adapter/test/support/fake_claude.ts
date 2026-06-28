// A fake `claude` process: replays a scripted model against the adapter's REAL
// in-process MCP server (over real localhost HTTP) and emits real stream-json
// lines. Only the model's decisions and the subprocess are faked — the MCP
// server, the prefix rename, the stream parser, and the usage mapping all run for
// real. This is the offline, deterministic seam (mirrors pi's faux provider).

import { CONTROL_TOOLS } from "@microfoom/core";
import type { ClaudeProcessFactory, ClaudeSpec } from "../../src/process.ts";
import { prefixedToolName } from "../../src/rename.ts";

/** One scripted model turn-step. */
export type FakeStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "delayText"; readonly ms: number; readonly text: string }
  | { readonly kind: "toolCall"; readonly name: string; readonly args: Record<string, unknown> };

const TERMINAL: ReadonlySet<string> = new Set([CONTROL_TOOLS.return, CONTROL_TOOLS.throw]);

const FAKE_USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

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
 * Build a process factory that replays `steps` across the run's turns (one shared
 * cursor, like the live model deciding turn by turn). Each subprocess (= one turn)
 * consumes steps until it ends the turn: a text reply, or a terminal foom_return /
 * foom_throw.
 */
export function fakeClaudeFactory(steps: readonly FakeStep[]): ClaudeProcessFactory {
  let cursor = 0;
  let rpcId = 1000;

  return (spec: ClaudeSpec) => {
    const sessionId = spec.sessionId ?? spec.resumeSessionId ?? "fake-session";

    async function* generate(): AsyncGenerator<string> {
      yield JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
      // Exercise tools/list exactly as the real CLI does at startup.
      await mcpCall(spec.mcpUrl, ++rpcId, "tools/list", {});

      let finalText = "";
      while (cursor < steps.length) {
        const step = steps[cursor];
        cursor += 1;
        if (step === undefined) break;

        if (step.kind === "text" || step.kind === "delayText") {
          if (step.kind === "delayText") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, step.ms);
              timer.unref?.();
            });
          }
          finalText = step.text;
          yield JSON.stringify({
            type: "assistant",
            session_id: sessionId,
            message: { role: "assistant", content: [{ type: "text", text: step.text }] },
          });
          break;
        }

        // A tool call: route it through the real MCP server, then echo the
        // assistant tool_use + the user tool_result, named as the model would see.
        const callId = `call_${cursor}`;
        const response = await mcpCall(spec.mcpUrl, ++rpcId, "tools/call", {
          name: step.name,
          arguments: step.args,
        });
        const result = (response.result ?? {}) as {
          content?: { text?: string }[];
          isError?: boolean;
        };
        const text = (result.content ?? []).map((part) => part.text ?? "").join("");
        yield JSON.stringify({
          type: "assistant",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: callId,
                name: prefixedToolName(spec.serverName, step.name),
                input: step.args,
              },
            ],
          },
        });
        yield JSON.stringify({
          type: "user",
          session_id: sessionId,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: callId,
                content: [{ type: "text", text }],
                is_error: result.isError === true,
              },
            ],
          },
        });
        if (TERMINAL.has(step.name)) break;
      }

      yield JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: finalText,
        total_cost_usd: 0,
        usage: FAKE_USAGE,
        session_id: sessionId,
      });
    }

    return { lines: generate(), kill: () => {}, stderr: () => "" };
  };
}
