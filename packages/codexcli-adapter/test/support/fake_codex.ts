// A fake `codex` process: replays a scripted model against the adapter's REAL
// in-process MCP server (over real localhost HTTP) and emits real `exec --json`
// JSONL lines. Only the model's decisions and the subprocess are faked — the MCP
// server, the stream parser, the usage mapping, and the session threading all run
// for real. This is the offline, deterministic seam (mirrors pi's faux provider).

import { CONTROL_TOOLS } from "@microfoom/core";
import type { CodexProcessFactory, CodexSpec } from "../../src/process.ts";

/** One scripted model turn-step. */
type FakeStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "delayText"; readonly ms: number; readonly text: string }
  | { readonly kind: "toolCall"; readonly name: string; readonly args: Record<string, unknown> };

const TERMINAL: ReadonlySet<string> = new Set([CONTROL_TOOLS.return, CONTROL_TOOLS.throw]);

const FAKE_USAGE = {
  input_tokens: 2,
  cached_input_tokens: 1,
  output_tokens: 1,
  reasoning_output_tokens: 0,
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
function fakeCodexFactory(steps: readonly FakeStep[]): CodexProcessFactory {
  let cursor = 0;
  let rpcId = 1000;

  return (spec: CodexSpec) => {
    const threadId = spec.resumeSessionId ?? "fake-thread";

    async function* generate(): AsyncGenerator<string> {
      yield JSON.stringify({ type: "thread.started", thread_id: threadId });
      yield JSON.stringify({ type: "turn.started" });
      // Exercise tools/list exactly as the real CLI does at startup.
      rpcId += 1;
      await mcpCall(spec.mcpUrl, rpcId, "tools/list", {});

      let itemId = 0;
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
          yield JSON.stringify({
            type: "item.completed",
            item: { id: `item_${itemId}`, type: "agent_message", text: step.text },
          });
          itemId += 1;
          break;
        }

        // A tool call: route it through the real MCP server, then echo the
        // item.started + item.completed mcp_tool_call as the CLI would.
        const id = `item_${itemId}`;
        itemId += 1;
        yield JSON.stringify({
          type: "item.started",
          item: {
            id,
            type: "mcp_tool_call",
            server: spec.serverName,
            tool: step.name,
            arguments: step.args,
            status: "in_progress",
          },
        });
        rpcId += 1;
        const response = await mcpCall(spec.mcpUrl, rpcId, "tools/call", {
          name: step.name,
          arguments: step.args,
        });
        const result = (response["result"] ?? {}) as {
          content?: Array<{ text?: string }>;
          isError?: boolean;
        };
        yield JSON.stringify({
          type: "item.completed",
          item: {
            id,
            type: "mcp_tool_call",
            server: spec.serverName,
            tool: step.name,
            arguments: step.args,
            result: { content: result.content ?? [] },
            error: result.isError === true ? { message: "tool error" } : null,
            status: result.isError === true ? "failed" : "completed",
          },
        });
        if (TERMINAL.has(step.name)) {
          // Codex emits a (usually empty) final agent_message after a tool turn.
          yield JSON.stringify({
            type: "item.completed",
            item: { id: `item_${itemId}`, type: "agent_message", text: "" },
          });
          itemId += 1;
          break;
        }
      }

      yield JSON.stringify({ type: "turn.completed", usage: FAKE_USAGE });
    }

    return {
      lines: generate(),
      kill: () => {
        /* fake process: nothing to kill */
      },
      stderr: () => "",
    };
  };
}

export type { FakeStep };
export { fakeCodexFactory };
