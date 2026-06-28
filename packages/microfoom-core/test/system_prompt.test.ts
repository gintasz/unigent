// What the TUI shows as the "system prompt" must be EXACTLY what the harness sends
// the model. Core builds the runtime block (preamble + foom_call announcements + the
// dev's systemPrompt); a harness MAY prepend its own base (pi does, AGENTS.md-style).
// `turn_meta` is sourced from HarnessSession.systemPrompt(), so the display reflects
// the composed whole. This file pins that invariant + the allowedTools cascade.

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import {
  foom,
  type HarnessSession,
  type OpenSession,
  Program,
  runProgram,
  type SessionTurnRequest,
  type SessionTurnResult,
} from "../src/index.ts";
import { makeStandardSchema } from "../src/standard_schema.ts";
import type { AgentEvent } from "../src/trace/index.ts";

const stringInput: StandardSchemaV1<unknown, string> = makeStandardSchema((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);

interface Sink {
  systemPrompt?: string;
  tools?: string[];
  /** request.allowedTools captured per turn, in order. */
  readonly allowedTools: (readonly string[] | undefined)[];
}

const emptySink = (): Sink => ({ allowedTools: [] });

/** A harness that records the exact prompt + tools it was handed, then ends the turn. */
function spyOpenSession(sink: Sink): OpenSession {
  const session: HarnessSession = {
    async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
      sink.systemPrompt = request.systemPrompt;
      sink.tools = request.tools.map((tool) => tool.name);
      sink.allowedTools.push(request.allowedTools);
      return { assistantText: "ok", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
  return () => session;
}

describe("system prompt fidelity", () => {
  it("turn_meta carries the EXACT system prompt handed to the harness", async () => {
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.text`go`;
      }

      @foom.expose({ announcement: "Returns a 0–100 risk score for a given finding count." })
      async score(findingCount: number): Promise<number> {
        return findingCount;
      }
    }

    const sink = emptySink();
    const events: AgentEvent[] = [];
    await runProgram(P, "x", {
      harnesses: { default: spyOpenSession(sink) },
      model: "fake",
      onEvent: (event: AgentEvent) => events.push(event),
    });

    const meta = events.find((event) => event.type === "turn_meta");
    expect(meta).toBeDefined();
    const shown = meta?.type === "turn_meta" ? meta.systemPrompt : undefined;

    // The displayed prompt is byte-identical to what the harness received.
    expect(shown).toBe(sink.systemPrompt);
    // …and it is the WHOLE prompt: runtime preamble + the exposed-method announcement.
    expect(shown).toContain("microfoom runtime");
    expect(shown).toContain("score: Returns a 0–100 risk score");

    // The foom_* tools are advertised to the harness separately (not in the prompt).
    expect(sink.tools).toContain("foom_call");
    expect(shown).not.toContain("foom_call(");
  });

  it("turn_meta reflects a harness that prepends its own base prompt", async () => {
    // A harness whose system prompt is `BASE + program prompt` (AGENTS.md-style).
    const base = "HARNESS BASE: you are an agent.";
    const recorded: { systemPrompt?: string } = {};
    const composing: OpenSession = () => ({
      systemPrompt: (programPrompt: string) => `${base}\n\n${programPrompt}`,
      async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
        recorded.systemPrompt = `${base}\n\n${request.systemPrompt}`;
        return { assistantText: "ok", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    });

    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.text`go`;
      }
    }

    const events: AgentEvent[] = [];
    await runProgram(P, "x", {
      harnesses: { default: composing },
      model: "fake",
      onEvent: (event: AgentEvent) => events.push(event),
    });

    const meta = events.find((event) => event.type === "turn_meta");
    const shown = meta?.type === "turn_meta" ? meta.systemPrompt : undefined;
    // The displayed prompt includes the harness base AND the runtime preamble, and
    // matches exactly what the harness sent the model.
    expect(shown).toContain("HARNESS BASE: you are an agent.");
    expect(shown).toContain("microfoom runtime");
    expect(shown).toBe(recorded.systemPrompt);
  });
});

describe("tools cascade (default → @foom.config → .with)", () => {
  it("threads the merged tool list to the harness request, nearest scope winning", async () => {
    const sink = emptySink();
    @foom.config({ tools: ["read", "bash"] })
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        const a = await this.agent.text`from class config`;
        const b = await this.agent.with({ tools: ["read"] }).text`narrowed`;
        return `${a}${b}`;
      }
    }
    await runProgram(P, "x", { harnesses: { default: spyOpenSession(sink) }, model: "fake" });
    // Turn 1 inherits the class config; turn 2's .with overrides it.
    expect(sink.allowedTools).toEqual([["read", "bash"], ["read"]]);
  });

  it("falls back to the run-level default when no narrower scope sets it", async () => {
    const sink = emptySink();
    class P extends Program<typeof stringInput, string>(stringInput) {
      async main(): Promise<string> {
        return await this.agent.text`go`;
      }
    }
    await runProgram(P, "x", {
      harnesses: { default: spyOpenSession(sink) },
      model: "fake",
      defaults: { tools: [] },
    });
    expect(sink.allowedTools).toEqual([[]]);
  });
});
