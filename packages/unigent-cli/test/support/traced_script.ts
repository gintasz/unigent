import {
  agent,
  type Backend,
  type BackendTurnRequest,
  type BackendTurnResult,
} from "@unigent/core";

const backend: Backend = {
  name: "fake",
  capabilities: {
    reportsCost: true,
    supportsSessionFork: false,
  },
  openSession: () => ({
    runTurn: async (request: BackendTurnRequest): Promise<BackendTurnResult> => {
      request.onEvent({ type: "reasoning", text: "Checking the requested name." });
      const delay = request.prompt === "__slow__" ? 10_000 : 300;
      await new Promise<void>((resolveWait, rejectWait) => {
        const timer = setTimeout(resolveWait, delay);
        request.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            rejectWait(request.signal.reason);
          },
          { once: true },
        );
      });
      request.onEvent({ type: "text", text: `Hello, ${request.prompt}.` });
      return {
        text: `Hello, ${request.prompt}.`,
        usage: {
          inputTokens: 12,
          outputTokens: 6,
          totalTokens: 18,
          costUsd: 0.0012,
        },
      };
    },
  }),
};

const name = process.argv[2] ?? "developer";
if (name === "__slow__") {
  console.log("SCRIPT READY");
}
const greeter = agent({ name: "greeter", backend, model: "test-model" });
const result = await greeter.run(name);
console.log(`SCRIPT OUTPUT: ${result.output}`);
