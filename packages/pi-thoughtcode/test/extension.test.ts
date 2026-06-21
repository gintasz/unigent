import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import thoughtcodeExtension, {
  createVibeReturnTool,
  createThoughtcodeTools,
  runThoughtcodeSubagent,
  vibeCallTool,
  vibeReturnTool,
} from "../dist/index.js";

const SCRATCH_DIR = "/tmp/agentic_coding";

describe("pi-thoughtcode", () => {
  it("exports the two Thoughtcode placeholder tools", () => {
    const tools = createThoughtcodeTools();

    expect(tools.map((tool) => tool.name)).toEqual(["VIBECALL", "VIBERETURN"]);
    expect(vibeCallTool.parameters.required).toEqual(["program_file_path", "name", "args"]);
    expect(vibeReturnTool.parameters.required).toEqual(["value"]);
  });

  it("registers tools through the PI extension factory", () => {
    const registered: ToolDefinition[] = [];

    thoughtcodeExtension({
      registerTool(tool) {
        registered.push(tool);
      },
    } as never);

    expect(registered.map((tool) => tool.name)).toEqual(["VIBECALL", "VIBERETURN"]);
  });

  it("loads into a PI AgentSession and exposes executable tools", async () => {
    const cwd = await mkdtemp(join(SCRATCH_DIR, "thoughtcode-cwd-"));
    const agentDir = await mkdtemp(join(SCRATCH_DIR, "thoughtcode-agent-"));
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [thoughtcodeExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await resourceLoader.reload();
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
    });

    try {
      expect(extensionsResult.errors).toEqual([]);
      expect(session.getAllTools().map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["VIBECALL", "VIBERETURN"]),
      );

      const vibeCall = session.getToolDefinition("VIBECALL");
      const vibeReturn = session.getToolDefinition("VIBERETURN");

      expect(vibeCall).toBeDefined();
      expect(vibeReturn).toBeDefined();
    } finally {
      session.dispose();
    }
  });

  it("spawns a subagent runner from VIBECALL and returns the VIBERETURN value", async () => {
    const [vibeCall] = createThoughtcodeTools({
      async runSubagent(request) {
        expect(request.call).toEqual({
          program_file_path: "./program.txt",
          name: "mul",
          args: "a=3,my number=9",
        });
        expect(request.prompt).toBe(
          [
            "ENTRYPOINT = mul",
            "ENTRYPOINT_ARGS = a=3,my number=9",
            "Read ./program.txt and literally execute it as if you were an interpreted.",
          ].join("\n"),
        );
        return "27";
      },
    });

    const callResult = await vibeCall.execute(
      "call-1",
      { program_file_path: "./program.txt", name: "mul", args: "a=3,my number=9" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(callResult.content).toEqual([{ type: "text", text: "27" }]);
    expect(callResult.details).toEqual({
      kind: "vibecall",
      program_file_path: "./program.txt",
      name: "mul",
      args: "a=3,my number=9",
      prompt: [
        "ENTRYPOINT = mul",
        "ENTRYPOINT_ARGS = a=3,my number=9",
        "Read ./program.txt and literally execute it as if you were an interpreted.",
      ].join("\n"),
      status: "done",
      result: "27",
    });
    expect(callResult.terminate).toBe(false);
  });

  it("captures VIBERETURN values and terminates the current subagent turn", async () => {
    let captured: string | undefined;
    const vibeReturn = createVibeReturnTool({
      onVibeReturn(value) {
        captured = value;
      },
    });

    const returnResult = await vibeReturn.execute(
      "return-1",
      { value: "27" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(captured).toBe("27");
    expect(returnResult.content).toEqual([{ type: "text", text: "27" }]);
    expect(returnResult.details).toEqual({ kind: "vibereturn", value: "27" });
    expect(returnResult.terminate).toBe(true);
  });

  it("does not terminate when VIBERETURN is called outside a VIBECALL subagent", async () => {
    const returnResult = await vibeReturnTool.execute(
      "return-1",
      { value: "27" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(returnResult.content).toEqual([
      { type: "text", text: "VIBERETURN ignored outside VIBECALL subagent: 27" },
    ]);
    expect(returnResult.details).toEqual({ kind: "vibereturn", value: "27" });
    expect(returnResult.terminate).toBe(false);
  });

  it("runs a PI child session until the child calls VIBERETURN", async () => {
    const faux = registerFauxProvider({
      api: "thoughtcode-faux-api",
      provider: "thoughtcode-faux",
      models: [{ id: "thoughtcode-faux-model" }],
    });
    const cwd = await mkdtemp(join(SCRATCH_DIR, "thoughtcode-cwd-"));
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey("thoughtcode-faux", "test-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const streamSimple = getApiProvider(faux.api)?.streamSimple;

    if (!streamSimple) {
      throw new Error("Faux provider did not register a stream.");
    }

    modelRegistry.registerProvider("thoughtcode-faux", {
      api: faux.api,
      apiKey: "test-key",
      baseUrl: "http://localhost:0",
      streamSimple,
      models: [
        {
          id: "thoughtcode-faux-model",
          name: "Thoughtcode Faux Model",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    });
    const model = modelRegistry.find("thoughtcode-faux", "thoughtcode-faux-model");

    if (!model) {
      throw new Error("Registered faux model was not found.");
    }

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("VIBERETURN", { value: "27" }), {
        stopReason: "toolUse",
      }),
    ]);

    try {
      const result = await runThoughtcodeSubagent({
        toolCallId: "call-1",
        call: {
          program_file_path: "./program.txt",
          name: "mul",
          args: "a=3,my number=9",
        },
        prompt: [
          "ENTRYPOINT = mul",
          "ENTRYPOINT_ARGS = a=3,my number=9",
          "Read ./program.txt and literally execute it as if you were an interpreted.",
        ].join("\n"),
        ctx: {
          cwd,
          model,
          modelRegistry,
        } as never,
        signal: undefined,
      });

      expect(result).toBe("27");
      expect(faux.state.callCount).toBe(1);
      expect(faux.getPendingResponseCount()).toBe(0);
    } finally {
      faux.unregister();
    }
  });
});
