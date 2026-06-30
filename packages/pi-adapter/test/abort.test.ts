import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { FoomCancelledError, type SessionTurnRequest } from "@microfoom/core";
import { describe, expect, it } from "vitest";
import { createPiOpenSession } from "../src/index.ts";

/** A pi OpenSession whose stream function is a spy: records whether the model was
 *  ever invoked, so a test can assert an aborted turn short-circuits before it. */
function spyHarness() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([]);
  const model = faux.getModel();
  let modelCalls = 0;
  return {
    openSession: createPiOpenSession({
      streamFn: (streamModel, context, streamOptions) => {
        modelCalls += 1;
        return models.streamSimple(streamModel, context, streamOptions);
      },
      resolveModel: () => model,
    }),
    model: model.id,
    modelCalls: () => modelCalls,
  };
}

const baseRequest: Omit<SessionTurnRequest, "signal"> = {
  systemPrompt: "system",
  prompt: "go",
  tools: [],
};

describe("pi adapter abort wiring", () => {
  it("rejects a pre-aborted turn with FoomCancelledError without invoking the model", async () => {
    const harness = spyHarness();
    const session = await harness.openSession({ model: harness.model });

    const request: SessionTurnRequest = { ...baseRequest, signal: AbortSignal.abort() };

    await expect(session.runTurn(request)).rejects.toBeInstanceOf(FoomCancelledError);
    expect(harness.modelCalls()).toBe(0);
  });
});
