// An offline, deterministic session for `--harness fake`: no model, no network, no
// key. It drives any program through the real FOOM tool handlers — on a value turn
// it calls foom_return with an echo of the prompt; on a text turn it returns that
// echo. Lets you smoke-test wiring/observability (and the CLI's own tests) without
// a provider. Returns a string, so string-typed programs (e.g. hello) settle.

import {
  CONTROL_TOOLS,
  type HarnessSession,
  type OpenSession,
  type SessionTurnRequest,
  type SessionTurnResult,
  type UsageDelta,
} from "@microfoom/core";

const FAKE_USAGE: UsageDelta = {
  inputTokens: 4,
  outputTokens: 6,
  totalTokens: 10,
  costUsd: 0,
};

/** An offline `OpenSession` that echoes the authored prompt and drives the
 *  same transcript stream a real harness would (reasoning / prose / tool events),
 *  so the panel and TUI work with no model. */

export function fakeOpenSession(): OpenSession {
  let calls = 0;
  const session: HarnessSession = {
    async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
      // Echo the AUTHORED prompt — strip microfoom's injected runtime notice block so
      // the fake's reply doesn't parrot the protocol instructions back at the user.
      const authored = request.prompt.replace(
        /<!-- microfoom:begin -->[\s\S]*?<!-- microfoom:end -->/g,
        " ",
      );
      const reply = `fake reply for: ${authored.slice(0, 60).replace(/\s+/g, " ").trim()}`;
      const emit = request.onEvent;
      // Drive the same transcript stream a real harness would, so the panel/TUI
      // shows reasoning + prose + tool calls offline (no model).
      emit?.({ type: "message_start" });
      emit?.({ type: "reasoning", delta: "thinking about the request… " });
      emit?.({ type: "reasoning", delta: "the answer is an echo." });
      const returnTool = request.tools.find((tool) => tool.name === CONTROL_TOOLS.return);
      if (returnTool !== undefined) {
        calls += 1;
        const callId = `fake-${calls}`;
        const args = { value: reply };
        emit?.({ type: "tool_call", callId, name: CONTROL_TOOLS.return, args });
        const result = await returnTool.execute(args);
        emit?.({ type: "tool_result", callId, content: result.content, isError: result.isError });
        emit?.({ type: "message_end" });
        return { assistantText: "", usage: FAKE_USAGE };
      }
      emit?.({ type: "text", delta: reply });
      emit?.({ type: "message_end" });
      return { assistantText: reply, usage: FAKE_USAGE };
    },
  };
  return () => session;
}
