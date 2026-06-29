// The codexcli E2EAdapter. `live` drives the real `codex` CLI (the user's Codex /
// ChatGPT login) against a real model. `scripted` drives the SAME adapter — its
// in-process MCP server, stream parser, and session threading all run — but a fake
// `codex` replays the fixture's neutral script against the live MCP server, so the
// suite is offline and deterministic. Constructed BARE for safety: the harness
// replaces Codex's coding-agent base prompt with only microfoom's prompt, disables
// Codex's shell tool, and exposes only the FOOM tools — so the model can never
// touch the machine, it can only speak the FOOM protocol.

import process from "node:process";
import {
  type CodexProcessFactory,
  type CodexSpec,
  createCodexCliOpenSession,
} from "@microfoom/codexcli-adapter";
import { CONTROL_TOOLS } from "@microfoom/core";
import type { E2EAdapter, RunContext } from "./adapters.ts";
import type { ScriptStep } from "./script.ts";

const TERMINAL: ReadonlySet<string> = new Set([CONTROL_TOOLS.return, CONTROL_TOOLS.throw]);

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

/** A fake `codex` process factory replaying a neutral ScriptStep[] (shared cursor
 *  across the run's turns) against the adapter's real in-process MCP server. */
function scriptedFactory(steps: readonly ScriptStep[]): CodexProcessFactory {
  let cursor = 0;
  let rpcId = 3000;

  return (spec: CodexSpec) => {
    const threadId = spec.resumeSessionId ?? "fake-thread";

    async function* generate(): AsyncGenerator<string> {
      yield JSON.stringify({ type: "thread.started", thread_id: threadId });
      yield JSON.stringify({ type: "turn.started" });
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
          yield JSON.stringify({
            type: "item.completed",
            item: { id: `item_${itemId}`, type: "agent_message", text: "" },
          });
          itemId += 1;
          break;
        }
      }

      yield JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 1 },
      });
    }

    return {
      lines: generate(),
      kill: () => {
        /* scripted process: nothing to kill */
      },
      stderr: () => "",
    };
  };
}

/** The codexcli harness adapter, driven live and scripted. */
export function codexcliE2EAdapter(): E2EAdapter {
  const liveModel = process.env["MICROFOOM_CODEXCLI_MODEL"] ?? "gpt-5-codex";
  return {
    name: "codexcli",
    live: {
      openSession: createCodexCliOpenSession(),
      model: liveModel,
    },
    scripted(steps): RunContext {
      return {
        openSession: createCodexCliOpenSession({ processFactory: scriptedFactory(steps) }),
        model: liveModel,
      };
    },
  };
}
