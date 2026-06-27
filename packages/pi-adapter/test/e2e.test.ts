import { FoomtimeHarnessError, makeStandardSchema, Program, runProgram } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { createPiOpenSession } from "../src/index.ts";

// Real-LLM diagnostic (Q2). Resolves model + key from ~/.pi (ModelRegistry).
// Model defaults to an OpenRouter DeepSeek model; override with MICROFOOM_E2E_MODEL.
// Skips — never fails — on missing config or a provider/auth/connection error.
const model = process.env.MICROFOOM_E2E_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "string" }] },
);
const numberSchema = makeStandardSchema<number>((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "number" }] },
);

describe("pi e2e (real model)", () => {
  it("drives a real model through the control tools to a value", async () => {
    class Pick extends Program<typeof stringSchema, number>(stringSchema) {
      async main(): Promise<number> {
        return await this.agent.value(
          numberSchema,
        )`Return the integer 42 via foom_return — nothing else.`;
      }
    }
    try {
      const out = await runProgram(Pick, "x", { openSession: createPiOpenSession(), model });
      console.warn(`e2e produced: ${out}`);
      expect(typeof out).toBe("number");
    } catch (error) {
      if (error instanceof FoomtimeHarnessError) {
        console.warn(`e2e skipped (provider): ${error.message}`);
        return;
      }
      throw error;
    }
  });
});
