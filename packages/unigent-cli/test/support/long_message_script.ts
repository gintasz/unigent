import {
  agent,
  type Backend,
  type BackendTurnRequest,
  type BackendTurnResult,
} from "@unigent/core";

const message = `${"debug detail ".repeat(800)}COMPLETE-TAIL`;
const result: BackendTurnResult = {
  text: message,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};
const backend: Backend = {
  name: "long-message",
  capabilities: {
    reportsCost: true,
    supportsSessionFork: false,
  },
  openSession: () => ({
    runTurn: (request: BackendTurnRequest) => {
      request.onEvent({ type: "text", text: message });
      return Promise.resolve(result);
    },
  }),
};

await agent({ name: "debugger", backend, model: "test-model" }).run("show every detail");
