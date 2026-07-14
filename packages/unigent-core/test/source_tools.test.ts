import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentConfigError, agent, type Backend, bakeSourceTools } from "../src/index.ts";

function multiply(left: number, right: number): number {
  return left * right;
}

const toolBackend: Backend = {
  name: "tool-test",
  capabilities: { reportsCost: false, supportsSessionFork: false },
  openSession: () => ({
    runTurn: async (request) => {
      const tool = request.tools.find((candidate) => candidate.name === "multiply");
      const result = await tool?.execute({ left: 6, right: 7 });
      return {
        text: result?.content ?? "missing tool",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  }),
};

describe("source tool production manifests", () => {
  it("bakes from config-relative TypeScript and runs from a JavaScript anchor", async () => {
    const root = mkdtempSync(join(tmpdir(), "unigent-bake-"));
    const sourceDirectory = join(root, "src");
    const outputDirectory = join(root, "dist");
    await mkdir(sourceDirectory, { recursive: true });
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, rootDir: "src", outDir: "dist" },
        include: ["src/**/*.ts"],
      }),
    );
    const entry = join(sourceDirectory, "entry.ts");
    writeFileSync(
      entry,
      `/** Multiply two numbers. */
function multiply(left: number, right: number): number {
  return left * right;
}
const options = { tools: [multiply] };
void options;
`,
    );

    try {
      const manifest = bakeSourceTools(entry);
      const assistant = agent({
        name: "baked",
        source: pathToFileURL(join(outputDirectory, "entry.js")).href,
        backend: toolBackend,
        model: "test",
        tools: [multiply],
      });

      expect(manifest).toBe(join(outputDirectory, "entry.unigent-tools.json"));
      expect((await assistant.run("multiply")).output).toBe("42");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects compiled anchors without a manifest before invoking TypeScript", () => {
    expect(() =>
      agent({
        name: "unbaked",
        source: "file:///tmp/unbaked.js",
        backend: toolBackend,
        model: "test",
        tools: [multiply],
      }),
    ).toThrow(AgentConfigError);
  });

  it("reflects edited source instead of retaining a stale TypeScript program", async () => {
    const root = mkdtempSync(join(tmpdir(), "unigent-live-source-"));
    const entry = join(root, "entry.ts");
    const observedSchemas: unknown[] = [];
    const backend: Backend = {
      ...toolBackend,
      openSession: () => ({
        runTurn: async (request) => {
          observedSchemas.push(request.tools.find((tool) => tool.name === "multiply")?.parameters);
          return {
            text: "observed",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    };
    const source = (parameterType: "number" | "string"): string => `/** Multiply two values. */
function multiply(left: ${parameterType}, right: ${parameterType}): ${parameterType} {
  return left;
}
void multiply;
`;

    try {
      writeFileSync(entry, source("number"));
      await agent({ name: "first", source: entry, backend, model: "test", tools: [multiply] }).run(
        "first",
      );
      writeFileSync(entry, source("string"));
      await agent({
        name: "second",
        source: entry,
        backend,
        model: "test",
        tools: [multiply],
      }).run("second");

      expect(observedSchemas).toEqual([
        expect.objectContaining({
          properties: expect.objectContaining({ left: { type: "number" } }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({ left: { type: "string" } }),
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
