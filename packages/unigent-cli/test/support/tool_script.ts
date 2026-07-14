import {
  agent,
  type Backend,
  type BackendTurnRequest,
  type BackendTurnResult,
} from "@unigent/core";

/** Assign a deterministic score. */
function rate(score: number): number {
  return score;
}

const backend: Backend = {
  name: "fake-tools",
  capabilities: {
    reportsCost: true,
    supportsSessionFork: false,
  },
  openSession: () => ({
    runTurn: async (request: BackendTurnRequest): Promise<BackendTurnResult> => {
      const rateTool = request.tools.find((candidate) => candidate.name === "rate");
      if (rateTool === undefined) {
        throw new Error("rate tool missing");
      }
      for (let index = 0; index < 3; index += 1) {
        const callId = `rate-${index}`;
        request.onEvent({ type: "tool_call", callId, name: "rate", input: { score: 90 + index } });
        const result = await rateTool.execute({ score: 90 + index });
        request.onEvent({
          type: "tool_result",
          callId,
          name: "rate",
          output: result.content,
          isError: result.isError,
        });
      }
      request.onEvent({ type: "text", text: "Scoring complete." });
      return {
        text: "Scoring complete.",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  }),
};

const scorer = agent({
  name: "scorer",
  source: import.meta.url,
  backend,
  model: "test-model",
  tools: [rate],
});
const evaluation = scorer.scope("evaluation");
evaluation.annotate({ candidates: 3 });
await evaluation.run("Score three drafts");
evaluation.log("best draft scored 92");

const reviewerBackend: Backend = {
  name: "fake-review",
  capabilities: {
    reportsCost: true,
    supportsSessionFork: false,
  },
  openSession: () => ({
    runTurn: async (request: BackendTurnRequest): Promise<BackendTurnResult> => {
      request.onEvent({ type: "text", text: "Review complete." });
      return await Promise.resolve({
        text: "Review complete.",
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      });
    },
  }),
};

await agent({ name: "reviewer", backend: reviewerBackend, model: "review-model" })
  .scope("evaluation")
  .scope("review")
  .run("Review the winner");
