// The harness base prompt + tools are opt-out via `omitHarnessBasePrompt` (default:
// include). Driven through the faux provider with injected `basePrompt`/`tools`, so
// we can assert the exact system prompt AND tool set the model receives — no network.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { makeStandardSchema, Program, runProgram } from "@microfoom/core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createPiOpenSession } from "../src/index.ts";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);

const BASE = "HARNESS BASE: you are an expert coding assistant.";
// A stand-in for one of pi's default tools (e.g. `read`).
const HARNESS_TOOL: AgentTool = {
  name: "read",
  label: "read",
  description: "read a file",
  parameters: Type.Object({}),
  execute: async () => ({ content: [], details: {} }),
};

/** Build a pi session over the faux provider, capturing the prompt + tools actually sent. */
function setup(omitHarnessBasePrompt: boolean) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("ok")]);
  const model = faux.getModel();
  let sentSystem: string | undefined;
  let sentTools: string[] = [];
  const openSession = createPiOpenSession({
    resolveModel: () => model,
    basePrompt: BASE,
    tools: [HARNESS_TOOL],
    omitHarnessBasePrompt,
    streamFn: (streamModel, context, streamOptions) => {
      sentSystem = context.systemPrompt;
      sentTools = (context.tools ?? []).map((tool) => tool.name);
      return models.streamSimple(streamModel, context, streamOptions);
    },
  });
  return { openSession, model: model.id, sent: () => sentSystem ?? "", tools: () => sentTools };
}

class Greeter extends Program<typeof stringSchema, string>(stringSchema) {
  async main(): Promise<string> {
    return await this.agent.text`go`;
  }
}

/** Run Greeter, optionally with a run-level tools default. */
async function run(
  openSession: ReturnType<typeof createPiOpenSession>,
  model: string,
  tools?: readonly string[],
): Promise<void> {
  await runProgram(Greeter, "x", {
    harnesses: { pi: openSession },
    model,
    ...(tools !== undefined ? { defaults: { tools } } : {}),
  });
}

describe("harness base prompt (omitHarnessBasePrompt)", () => {
  it("prepends the base by default (omit=false), runtime block after it", async () => {
    const { openSession, model, sent } = setup(false);
    await run(openSession, model);
    expect(sent()).toContain(BASE);
    expect(sent()).toContain("microfoom runtime");
    // Base comes first, microfoom's block second (AGENTS.md-style append).
    expect(sent().indexOf(BASE)).toBeLessThan(sent().indexOf("microfoom runtime"));
  });

  it("drops the base when omit=true — only microfoom's prompt is sent", async () => {
    const { openSession, model, sent } = setup(true);
    await run(openSession, model);
    expect(sent()).not.toContain(BASE);
    expect(sent()).toContain("microfoom runtime");
  });

  it("omit is decoupled from tools: base dropped but harness tools remain", async () => {
    const { openSession, model, sent, tools } = setup(true);
    await run(openSession, model);
    expect(sent()).not.toContain(BASE);
    expect(tools()).toContain("read");
  });
});

describe("allowedTools (per-turn harness tool allowlist)", () => {
  it("undefined → all harness tools + FOOM tools", async () => {
    const { openSession, model, tools } = setup(false);
    await run(openSession, model);
    expect(tools()).toContain("read");
    expect(tools().some((name) => name.startsWith("foom_"))).toBe(true);
  });

  it("[] → no harness tools, only FOOM tools", async () => {
    const { openSession, model, tools } = setup(false);
    await run(openSession, model, []);
    expect(tools()).not.toContain("read");
    expect(tools().every((name) => name.startsWith("foom_"))).toBe(true);
  });

  it("[names] → only the listed harness tools + FOOM tools", async () => {
    const { openSession, model, tools } = setup(false);
    await run(openSession, model, ["read"]);
    expect(tools()).toContain("read");
    expect(tools()).not.toContain("bash"); // not in HARNESS_TOOL set anyway, but explicit
  });
});
