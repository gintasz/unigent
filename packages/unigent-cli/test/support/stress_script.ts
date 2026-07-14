import { agent, type Backend, type BackendTurnResult } from "@unigent/core";

const RUN_COUNT = 5000;
const result: BackendTurnResult = {
  text: "done",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};
const backend: Backend = {
  name: "stress",
  capabilities: {
    reportsCost: true,
    supportsSessionFork: false,
  },
  openSession: () => ({ runTurn: () => Promise.resolve(result) }),
};
const worker = agent({ name: "worker", backend, model: "test-model" });

for (let index = 0; index < RUN_COUNT; index += 1) {
  await worker.run(`job ${index}`);
}
console.log(`STRESS COMPLETE: ${RUN_COUNT}`);
