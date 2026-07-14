import process from "node:process";
import { AgentBackendUnavailableError, agent, claudeCli, codexCli, piAgent } from "@unigent/sdk";
import { describe, expect, it, type TestContext } from "vitest";
import { z } from "zod";

const PI_MODEL = process.env["UNIGENT_E2E_PI_MODEL"] ?? "openrouter/deepseek/deepseek-v4-flash";
const CLAUDE_MODEL = process.env["UNIGENT_E2E_CLAUDE_MODEL"] ?? "sonnet";
const CODEX_MODEL = process.env["UNIGENT_E2E_CODEX_MODEL"] ?? "gpt-5.4";

async function live(context: TestContext, test: () => Promise<void>): Promise<void> {
  try {
    await test();
  } catch (error) {
    if (error instanceof AgentBackendUnavailableError) {
      context.skip(`backend unavailable: ${error.message}`);
    }
    throw error;
  }
}

describe("Unigent real-backend E2E", () => {
  it(
    "runs structured output and tracing through the real Pi agent SDK",
    async (context) =>
      live(context, async () => {
        const assistant = agent({
          name: "pi-e2e",
          backend: piAgent(),
          model: PI_MODEL,
          limits: { turnDuration: "90s" },
        });

        const result = await assistant.run(
          "Return an object whose status is exactly UNIGENT_PI_OK.",
          z.object({ status: z.literal("UNIGENT_PI_OK") }),
        );

        expect(result.output).toEqual({ status: "UNIGENT_PI_OK" });
        expect(result.trace.events.length).toBeGreaterThan(1);
        expect(result.usage.totalTokens).toBeGreaterThan(0);
      }),
    120_000,
  );

  it(
    "runs structured output and MCP tools through the real Claude CLI",
    async (context) =>
      live(context, async () => {
        const assistant = agent({
          name: "claude-e2e",
          backend: claudeCli({ nativeTools: [] }),
          model: CLAUDE_MODEL,
          limits: { turnDuration: "90s" },
        });

        const result = await assistant.run(
          "Return an object whose status is exactly UNIGENT_CLAUDE_OK.",
          z.object({ status: z.literal("UNIGENT_CLAUDE_OK") }),
        );

        expect(result.output).toEqual({ status: "UNIGENT_CLAUDE_OK" });
        expect(
          result.trace.events.some(
            (event) => event.type === "tool_call" && event.name === "unigent_return",
          ),
        ).toBe(true);
        expect(
          result.trace.events.some(
            (event) => event.type === "tool_result" && event.name === "unigent_return",
          ),
        ).toBe(true);
        expect(result.usage.totalTokens).toBeGreaterThan(0);
      }),
    120_000,
  );

  it(
    "runs structured output and MCP tools through the real Codex CLI",
    async (context) =>
      live(context, async () => {
        const assistant = agent({
          name: "codex-e2e",
          backend: codexCli({ nativeTools: [] }),
          model: CODEX_MODEL,
          limits: { turnDuration: "90s" },
        });

        const result = await assistant.run(
          "Return an object whose status is exactly UNIGENT_CODEX_OK.",
          z.object({ status: z.literal("UNIGENT_CODEX_OK") }),
        );

        expect(result.output).toEqual({ status: "UNIGENT_CODEX_OK" });
        expect(
          result.trace.events.some(
            (event) => event.type === "tool_call" && event.name === "unigent_return",
          ),
        ).toBe(true);
        expect(
          result.trace.events.some(
            (event) => event.type === "tool_result" && event.name === "unigent_return",
          ),
        ).toBe(true);
        expect(result.usage.totalTokens).toBeGreaterThan(0);
      }),
    120_000,
  );

  it(
    "runs Pi and Claude CLI concurrently without crossing traces or outputs",
    async (context) =>
      live(context, async () => {
        const pi = agent({
          name: "pi-concurrent",
          backend: piAgent(),
          model: PI_MODEL,
          limits: { turnDuration: "90s" },
        });
        const claude = agent({
          name: "claude-concurrent",
          backend: claudeCli({ nativeTools: [] }),
          model: CLAUDE_MODEL,
          limits: { turnDuration: "90s" },
        });

        const [piResult, claudeResult] = await Promise.all([
          pi.run("Respond with exactly UNIGENT_PI_CONCURRENT_OK."),
          claude.run("Respond with exactly UNIGENT_CLAUDE_CONCURRENT_OK."),
        ]);

        expect(piResult.output).toContain("UNIGENT_PI_CONCURRENT_OK");
        expect(claudeResult.output).toContain("UNIGENT_CLAUDE_CONCURRENT_OK");
        expect(piResult.trace.traceId).not.toBe(claudeResult.trace.traceId);
        expect(
          piResult.trace.events.every((event) => event.traceId === piResult.trace.traceId),
        ).toBe(true);
        expect(
          claudeResult.trace.events.every((event) => event.traceId === claudeResult.trace.traceId),
        ).toBe(true);
      }),
    120_000,
  );
});
