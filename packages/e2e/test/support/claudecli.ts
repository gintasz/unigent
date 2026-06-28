// The claudecli E2EAdapter. `live` drives the real `claude` CLI (the user's
// subscription) against a real model. `scripted` drives the SAME adapter — its
// rename, in-process MCP server, stream parser, and session threading all run —
// but a fake `claude` replays the fixture's neutral script against the live MCP
// server, so the suite is offline and deterministic. Constructed BARE for safety:
// the harness sends only microfoom's prompt (default replace mode) and every run
// passes `allowedTools: []`, so Claude's own filesystem tools are never advertised.

import {
  type ClaudeProcessFactory,
  type ClaudeSpec,
  createClaudeCliOpenSession,
} from "@microfoom/claudecli-adapter";
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

/** A fake `claude` process factory replaying a neutral ScriptStep[] (shared cursor
 *  across the run's turns) against the adapter's real in-process MCP server. */
function scriptedFactory(steps: readonly ScriptStep[]): ClaudeProcessFactory {
  let cursor = 0;
  let rpcId = 2000;

  return (spec: ClaudeSpec) => {
    const sessionId = spec.sessionId ?? spec.resumeSessionId ?? "fake-session";
    const prefixed = (name: string) => `mcp__${spec.serverName}__${name}`;

    async function* generate(): AsyncGenerator<string> {
      yield JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
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
              { type: "tool_use", id: callId, name: prefixed(step.name), input: step.args },
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
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
        session_id: sessionId,
      });
    }

    return { lines: generate(), kill: () => {}, stderr: () => "" };
  };
}

/** The claudecli harness adapter, driven live and scripted. */
export function claudecliE2EAdapter(): E2EAdapter {
  const liveModel = process.env.MICROFOOM_CLAUDECLI_MODEL ?? "sonnet";
  return {
    name: "claudecli",
    live: {
      openSession: createClaudeCliOpenSession(),
      model: liveModel,
    },
    scripted(steps): RunContext {
      return {
        openSession: createClaudeCliOpenSession({ processFactory: scriptedFactory(steps) }),
        model: "sonnet",
      };
    },
  };
}
