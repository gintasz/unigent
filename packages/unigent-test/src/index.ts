import {
  AgentBackendRejectedError,
  type Backend,
  type BackendCapabilities,
  type BackendEvent,
  type BackendSession,
  type BackendSessionOptions,
  type BackendTurnRequest,
  type BackendTurnResult,
  type BackendUsage,
} from "@unigent/core";

/** Context supplied to a deterministic backend turn handler. */
interface TestTurnContext {
  readonly model: string;
  readonly sessionId: number;
  readonly turnIndex: number;
  readonly sessionTurnIndex: number;
}

type TestTurnHandler = (
  request: BackendTurnRequest,
  context: TestTurnContext,
) => BackendTurnResult | Promise<BackendTurnResult>;

interface TestBackendOptions {
  readonly name?: string;
  readonly checkpointKey?: string;
  readonly capabilities?: Partial<BackendCapabilities>;
}

/** Inspectable deterministic backend suitable for application integration tests. */
interface TestBackend extends Backend {
  readonly requests: readonly BackendTurnRequest[];
  readonly openedModels: readonly string[];
}

interface TestToolCall {
  readonly name: string;
  readonly input: unknown;
  readonly callId?: string;
}

interface ScriptedTurn {
  readonly text?: string;
  readonly usage?: BackendUsage;
  readonly events?: readonly BackendEvent[];
  readonly toolCalls?: readonly TestToolCall[];
}

interface BackendContractResult {
  readonly firstText: string;
  readonly forkText: string;
  readonly events: readonly BackendEvent[];
}

const DEFAULT_USAGE: BackendUsage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  costUsd: 0,
};

/** Build a settled test result with normalized defaults. */
function testResult(text: string, usage: BackendUsage = DEFAULT_USAGE): BackendTurnResult {
  return { text, usage };
}

/** Create an inspectable backend from a programmable deterministic handler. */
function createTestBackend(
  handler: TestTurnHandler,
  options: TestBackendOptions = {},
): TestBackend {
  const requests: BackendTurnRequest[] = [];
  const openedModels: string[] = [];
  let nextSessionId = 0;
  let nextTurnIndex = 0;
  const makeSession = (model: string, sessionId: number, seed = 0): BackendSession => {
    let sessionTurnIndex = seed;
    return {
      runTurn: async (request: BackendTurnRequest): Promise<BackendTurnResult> => {
        requests.push(request);
        const context: TestTurnContext = {
          model,
          sessionId,
          turnIndex: nextTurnIndex,
          sessionTurnIndex,
        };
        nextTurnIndex += 1;
        sessionTurnIndex += 1;
        return await handler(request, context);
      },
      fork: (): BackendSession => makeSession(model, sessionId, sessionTurnIndex),
    };
  };
  return {
    name: options.name ?? "test",
    checkpointKey: options.checkpointKey ?? "unigent-test-v1",
    capabilities: {
      reportsCost: options.capabilities?.reportsCost ?? true,
      supportsSessionFork: options.capabilities?.supportsSessionFork ?? true,
    },
    openSession: ({ model }: BackendSessionOptions): BackendSession => {
      openedModels.push(model);
      const sessionId = nextSessionId;
      nextSessionId += 1;
      return makeSession(model, sessionId);
    },
    get requests(): readonly BackendTurnRequest[] {
      return requests;
    },
    get openedModels(): readonly string[] {
      return openedModels;
    },
  };
}

async function executeScriptedTurn(
  request: BackendTurnRequest,
  turn: ScriptedTurn,
  turnIndex: number,
): Promise<BackendTurnResult> {
  for (const event of turn.events ?? []) {
    request.onEvent(event);
  }
  for (const [index, call] of (turn.toolCalls ?? []).entries()) {
    const tool = request.tools.find((candidate) => candidate.name === call.name);
    if (tool === undefined) {
      throw new AgentBackendRejectedError(`scripted tool is unavailable: ${call.name}`);
    }
    const callId = call.callId ?? `test-${turnIndex}-${index}`;
    request.onEvent({ type: "tool_call", callId, name: call.name, input: call.input });
    const result = await tool.execute(call.input);
    request.onEvent({
      type: "tool_result",
      callId,
      name: call.name,
      output: result.content,
      isError: result.isError,
    });
    if (result.terminate === true) {
      break;
    }
  }
  return testResult(turn.text ?? "", turn.usage);
}

/** Create a deterministic backend from declarative turns consumed in order. */
function createScriptedBackend(
  turns: readonly ScriptedTurn[],
  options: TestBackendOptions = {},
): TestBackend {
  return createTestBackend(async (request, context): Promise<BackendTurnResult> => {
    const turn = turns[context.turnIndex];
    if (turn === undefined) {
      throw new AgentBackendRejectedError(`no scripted turn at index ${context.turnIndex}`);
    }
    return await executeScriptedTurn(request, turn, context.turnIndex);
  }, options);
}

function contractRequest(prompt: string, events: BackendEvent[]): BackendTurnRequest {
  return {
    systemPrompt: "UNIGENT BACKEND CONTRACT",
    systemPromptMode: "replace",
    prompt,
    tools: [],
    signal: new AbortController().signal,
    onEvent: (event: BackendEvent): void => {
      events.push(event);
    },
  };
}

/** Exercise the shared prose and fork contract implemented by every Unigent backend. */
async function exerciseBackendContract(
  backend: Backend,
  model: string,
): Promise<BackendContractResult> {
  const events: BackendEvent[] = [];
  const session = await backend.openSession({ model });
  const first = await session.runTurn(contractRequest("contract first", events));
  if (session.fork === undefined) {
    throw new AgentBackendRejectedError(`${backend.name} does not implement session forks`);
  }
  const branch = session.fork();
  const forked = await branch.runTurn(contractRequest("contract fork", events));
  return { firstText: first.text, forkText: forked.text, events };
}

export type {
  BackendContractResult,
  ScriptedTurn,
  TestBackend,
  TestBackendOptions,
  TestToolCall,
  TestTurnContext,
  TestTurnHandler,
};
export { createScriptedBackend, createTestBackend, exerciseBackendContract, testResult };
