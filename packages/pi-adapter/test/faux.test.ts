import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { CONTROL_TOOLS, makeStandardSchema, Program, runProgram } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { createPiOpenSession } from "../src/index.ts";

const stringSchema = makeStandardSchema<string>((input) =>
  typeof input === "string" ? { value: input } : { issues: [{ message: "expected a string" }] },
);
const numberSchema = makeStandardSchema<number>((input) =>
  typeof input === "number" ? { value: input } : { issues: [{ message: "expected a number" }] },
);

function harnessFor(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  const model = faux.getModel();
  return {
    openSession: createPiOpenSession({
      streamFn: (streamModel, context, streamOptions) =>
        models.streamSimple(streamModel, context, streamOptions),
      resolveModel: () => model,
    }),
    model: model.id,
  };
}

describe("pi harness session via faux provider (deterministic)", () => {
  it("maps a text turn through pi-agent-core + pi-ai", async () => {
    const { openSession, model } = harnessFor([fauxAssistantMessage("hello from pi")]);
    class Greeter extends Program<typeof stringSchema, string>(stringSchema) {
      async main(): Promise<string> {
        return await this.agent.text`Greet me.`;
      }
    }
    const out = await runProgram(Greeter, "x", { openSession, model });
    expect(out).toBe("hello from pi");
  });

  it("maps a value turn (foom_return tool call) through pi", async () => {
    const { openSession, model } = harnessFor([
      fauxAssistantMessage([fauxToolCall(CONTROL_TOOLS.return, { value: 7 })], {
        stopReason: "toolUse",
      }),
    ]);
    class Picker extends Program<typeof stringSchema, number>(stringSchema) {
      async main(): Promise<number> {
        return await this.agent.value(numberSchema)`Pick a number.`;
      }
    }
    const out = await runProgram(Picker, "x", { openSession, model });
    expect(out).toBe(7);
  });
});
