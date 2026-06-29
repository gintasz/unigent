// An e2e adapter: how the suite obtains an OpenSession to run fixtures against,
// in two modes. `live` drives the real model through the real harness adapter
// (the thing we ultimately want to prove works). `scripted` drives the SAME real
// harness adapter, but with a faux provider underneath — the adapter's neutral↔
// provider mapping still runs; only the model's replies are canned, so error
// paths (repair, missing-return, caps) become deterministic and offline. Adding a
// future adapter means adding one more E2EAdapter here; the fixtures never change.
//
// Both modes are constructed BARE for safety (the user's requirement): the harness
// base prompt is omitted (`omitHarnessBasePrompt`) and every run passes
// `allowedTools: []`, so the harness's own filesystem tools are never advertised
// to the model — it cannot touch the machine, it can only speak the FOOM protocol.

import process from "node:process";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { OpenSession } from "@microfoom/core";
import { createPiOpenSession } from "@microfoom/pi-adapter";
import { claudecliE2EAdapter } from "./claudecli.ts";
import { opencodeE2EAdapter } from "./opencode.ts";
import type { ScriptStep } from "./script.ts";

/** Everything a fixture needs to run a program once. */
interface RunContext {
  readonly openSession: OpenSession;
  readonly model: string;
}

interface E2EAdapter {
  readonly name: string;
  /** Drive the real model (resolved from the host's harness config). */
  readonly live: RunContext;
  /** Drive the real adapter over a faux provider seeded with this script. */
  scripted: (steps: readonly ScriptStep[]) => RunContext;
}

// The faux provider's response list type, taken from its own API so we never name
// an internal type. Each step is an assistant message or a factory producing one.
type FauxSteps = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

function toFauxStep(step: ScriptStep): FauxSteps[number] {
  if (step.kind === "text") {
    return fauxAssistantMessage(step.text);
  }
  if (step.kind === "toolCall") {
    return fauxAssistantMessage([fauxToolCall(step.name, step.args)], { stopReason: "toolUse" });
  }
  // A factory that stalls before producing prose, to trip a turn-duration cap.
  // The timer is unref'd so it never keeps the test process alive.
  return async () => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, step.ms);
      timer.unref?.();
    });
    return fauxAssistantMessage(step.text);
  };
}

/** The reference adapter: microfoom's pi harness. */
function piE2EAdapter(): E2EAdapter {
  const liveModel = process.env["MICROFOOM_E2E_MODEL"] ?? "openrouter/deepseek/deepseek-v4-flash";
  return {
    name: "pi",
    live: {
      openSession: createPiOpenSession({ omitHarnessBasePrompt: true }),
      model: liveModel,
    },
    scripted(steps) {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses(steps.map(toFauxStep));
      const model = faux.getModel();
      return {
        openSession: createPiOpenSession({
          streamFn: (streamModel, context, streamOptions) =>
            models.streamSimple(streamModel, context, streamOptions),
          resolveModel: () => model,
          omitHarnessBasePrompt: true,
        }),
        model: model.id,
      };
    },
  };
}

/** Every adapter the suite exercises. Append future adapters here; the fixtures
 *  never change. */
const adapters: readonly E2EAdapter[] = [
  piE2EAdapter(),
  claudecliE2EAdapter(),
  opencodeE2EAdapter(),
];

export type { E2EAdapter, RunContext };
export { adapters, piE2EAdapter };
