import {
  agent,
  claudeCli,
  codexCli,
  done,
  fail,
  type PiAgentOptions,
  parseArgs,
  piAgent,
} from "@unigent/sdk";
import { startMcpToolServer } from "@unigent/sdk/mcp";
import { createScriptedBackend } from "@unigent/sdk/test";
import { TraceProjection } from "@unigent/sdk/trace";
import { describe, expect, it } from "vitest";

describe("unigent facade", () => {
  it("exports the core API and every official harness", () => {
    const piOptions: PiAgentOptions = {};

    expect(typeof agent).toBe("function");
    expect(done).toBeDefined();
    expect(typeof parseArgs).toBe("function");
    expect(typeof startMcpToolServer).toBe("function");
    expect(typeof createScriptedBackend).toBe("function");
    expect(fail).toBeDefined();
    expect(new TraceProjection().snapshot().eventCount).toBe(0);
    expect(piAgent(piOptions).name).toBe("pi");
    expect(claudeCli({ nativeTools: [] }).name).toBe("claude-cli");
    expect(codexCli({ nativeTools: [] }).name).toBe("codex-cli");
  });
});
