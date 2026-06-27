import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import microfoomExtension from "../src/extension.ts";

const fixture = fileURLToPath(new URL("./fixtures/run_program.ts", import.meta.url));

const original = process.env.MICROFOOM_CONFIG;
afterEach(() => {
  if (original === undefined) delete process.env.MICROFOOM_CONFIG;
  else process.env.MICROFOOM_CONFIG = original;
});

function mockPi() {
  const commands = new Map<string, { description?: string }>();
  const tools = new Map<string, { description: string; parameters: unknown }>();
  const pi = {
    registerCommand: (name: string, options: { description?: string }) =>
      commands.set(name, options),
    registerTool: (tool: { name: string; description: string; parameters: unknown }) =>
      tools.set(tool.name, tool),
    registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;
  return { pi, commands, tools };
}

describe("extension program registration", () => {
  it("registers config programs as commands and tools (params derived from main)", () => {
    const dir = mkdtempSync(join(tmpdir(), "microfoom-"));
    const configPath = join(dir, "microfoom.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "fake",
        programs: [
          { disable_model_invocation: true, path: fixture },
          {
            disable_model_invocation: false,
            path: fixture,
            name: "doubler",
            description: "Doubles a number",
          },
        ],
      }),
    );
    process.env.MICROFOOM_CONFIG = configPath;

    const { pi, commands, tools } = mockPi();
    microfoomExtension(pi);

    expect(commands.has("microfoom-run")).toBe(true); // the ad-hoc runner is always registered
    expect(commands.has("run_program")).toBe(true); // command entry, default name = filename stem
    const tool = tools.get("doubler");
    expect(tool?.description).toBe("Doubles a number");
    const params = tool?.parameters as { properties?: Record<string, { type?: string }> };
    expect(params.properties?.seed?.type).toBe("number"); // derived from main(seed: number)
  });
});
