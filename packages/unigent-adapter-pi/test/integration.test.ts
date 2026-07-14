import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  AgentConfigError,
  type BackendEvent,
  type BackendTool,
  type BackendTurnRequest,
} from "@unigent/core";
import { exerciseBackendContract } from "@unigent/test";
import { describe, expect, it } from "vitest";
import { type PiAgentOptions, piAgent } from "../src/index.ts";

function setup(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  overrides: Partial<PiAgentOptions> = {},
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const model = faux.getModel();
  const backend = piAgent({
    streamFn: (streamModel, context, options) => models.streamSimple(streamModel, context, options),
    resolveModel: () => model,
    basePrompt: "PI MACHINE PROMPT",
    ...overrides,
  });
  return { backend, model: model.id };
}

function request(prompt: string, tools: readonly BackendTool[] = []): BackendTurnRequest {
  return {
    systemPrompt: "UNIGENT PROMPT",
    systemPromptMode: "replace",
    prompt,
    tools,
    signal: new AbortController().signal,
    onEvent: () => undefined,
  };
}

describe("Pi backend integration", () => {
  it("satisfies the shared backend prose and fork contract", async () => {
    const { backend, model } = setup([
      fauxAssistantMessage("contract-first"),
      fauxAssistantMessage("contract-fork"),
    ]);

    const result = await exerciseBackendContract(backend, model);

    expect(result).toMatchObject({ firstText: "contract-first", forkText: "contract-fork" });
  });

  it("runs prose through pi-agent-core and pi-ai", async () => {
    const { backend, model } = setup([fauxAssistantMessage("hello from pi")]);
    const session = await backend.openSession({ model });

    const result = await session.runTurn(request("hello"));

    expect(result.text).toBe("hello from pi");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it("keeps clean prompts isolated and appends the machine prompt only when requested", async () => {
    let cleanPrompt: string | undefined;
    const clean = setup([
      (context) => {
        cleanPrompt = context.systemPrompt;
        return fauxAssistantMessage("clean");
      },
    ]);
    const cleanSession = await clean.backend.openSession({ model: clean.model });
    await cleanSession.runTurn({ ...request("clean"), systemPromptMode: "append" });

    let machinePrompt: string | undefined;
    const machine = setup(
      [
        (context) => {
          machinePrompt = context.systemPrompt;
          return fauxAssistantMessage("machine");
        },
      ],
      { base: "machine" },
    );
    const machineSession = await machine.backend.openSession({ model: machine.model });
    await machineSession.runTurn({ ...request("machine"), systemPromptMode: "append" });

    expect(cleanPrompt).toBe("UNIGENT PROMPT");
    expect(machinePrompt).toBe("PI MACHINE PROMPT\n\nUNIGENT PROMPT");
  });

  it("executes Unigent tools inside Pi's real agent loop", async () => {
    const { backend, model } = setup([
      fauxAssistantMessage([fauxToolCall("finish", { value: 7 })], { stopReason: "toolUse" }),
    ]);
    let received: unknown;
    const finish: BackendTool = {
      name: "finish",
      description: "finish",
      parameters: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      execute: async (input) => {
        received = input;
        return { content: "accepted", isError: false, terminate: true };
      },
    };
    const session = await backend.openSession({ model });

    await session.runTurn(request("pick", [finish]));

    expect(received).toEqual({ value: 7 });
  });

  it("changes the tool surface between turns of one Pi session", async () => {
    const toolSurfaces: string[][] = [];
    const finish: BackendTool = {
      name: "finish",
      description: "finish",
      parameters: { type: "object" },
      execute: async () => ({ content: "accepted", isError: false, terminate: true }),
    };
    const { backend, model } = setup([
      (context) => {
        toolSurfaces.push((context.tools ?? []).map((candidate) => candidate.name));
        return fauxAssistantMessage("first");
      },
      (context) => {
        toolSurfaces.push((context.tools ?? []).map((candidate) => candidate.name));
        return fauxAssistantMessage([fauxToolCall("finish", {})], { stopReason: "toolUse" });
      },
      (context) => {
        toolSurfaces.push((context.tools ?? []).map((candidate) => candidate.name));
        return fauxAssistantMessage("third");
      },
    ]);
    const session = await backend.openSession({ model });

    await session.runTurn(request("first"));
    await session.runTurn(request("structured", [finish]));
    await session.runTurn(request("third"));

    expect(toolSurfaces.map((tools) => tools.includes("finish"))).toEqual([false, true, false]);
  });

  it("forks a transcript into an independent Pi session", async () => {
    const { backend, model } = setup([
      fauxAssistantMessage("base"),
      fauxAssistantMessage("branch"),
    ]);
    const session = await backend.openSession({ model });
    await session.runTurn(request("start"));

    const branch = session.fork?.();

    expect(branch).toBeDefined();
    expect((await branch?.runTurn(request("continue")))?.text).toBe("branch");
  });

  it("rejects unknown native tools and invalid thinking levels", async () => {
    const unknown = setup([fauxAssistantMessage("unused")], { nativeTools: ["missing"] });
    await expect(unknown.backend.openSession({ model: unknown.model })).rejects.toThrow(
      AgentConfigError,
    );

    const invalid = setup([fauxAssistantMessage("unused")]);
    const session = await invalid.backend.openSession({ model: invalid.model });
    await expect(session.runTurn({ ...request("think"), thinking: "impossible" })).rejects.toThrow(
      "unsupported Pi thinking level",
    );
  });

  it("rejects plugin and skill controls that an injected stream cannot apply", async () => {
    const plugin = setup([fauxAssistantMessage("unused")], { plugins: ["plugin"] });
    await expect(plugin.backend.openSession({ model: plugin.model })).rejects.toThrow(
      AgentConfigError,
    );

    const skill = setup([fauxAssistantMessage("unused")], { skills: ["skill"] });
    await expect(skill.backend.openSession({ model: skill.model })).rejects.toThrow(
      AgentConfigError,
    );
  });

  it("rebuilds Pi wiring after a transient construction failure", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("recovered")]);
    const model = faux.getModel();
    let streamReads = 0;
    const options = new Proxy<PiAgentOptions>(
      {
        streamFn: (streamModel, context, streamOptions) =>
          models.streamSimple(streamModel, context, streamOptions),
        resolveModel: () => model,
      },
      {
        get: (target, property, receiver) => {
          if (property === "streamFn") {
            streamReads += 1;
            if (streamReads === 2) {
              throw new Error("temporary wiring failure");
            }
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const backend = piAgent(options);

    await expect(backend.openSession({ model: model.id })).rejects.toThrow(
      "temporary wiring failure",
    );
    const session = await backend.openSession({ model: model.id });

    await expect(session.runTurn(request("recover"))).resolves.toMatchObject({
      text: "recovered",
    });
  });

  it("propagates Unigent tool failures as Pi tool errors", async () => {
    const { backend, model } = setup([
      fauxAssistantMessage([fauxToolCall("repairable", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("recovered"),
    ]);
    const events: BackendEvent[] = [];
    const repairable: BackendTool = {
      name: "repairable",
      description: "repairable",
      parameters: { type: "object" },
      execute: async () => ({ content: "invalid arguments", isError: true }),
    };
    const session = await backend.openSession({ model });

    const result = await session.runTurn({
      ...request("repair", [repairable]),
      onEvent: (event) => events.push(event),
    });

    expect(result.text).toBe("recovered");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_result", name: "repairable", isError: true }),
    );
  });
});
