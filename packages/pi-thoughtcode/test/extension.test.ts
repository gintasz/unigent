import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxThinking, fauxToolCall, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
  VIBE_CALL_TOOL_PARAMETERS,
  VIBE_RETURN_TOOL_PARAMETERS,
  buildVibeCallSubagentPrompt,
  type VibeCallArgs,
} from "thoughtcode-core";
import { beforeEach, describe, expect, it } from "vitest";
import thoughtcodeExtension, {
  clearVibeCallRunsForTests,
  createVibeReturnTool,
  createThoughtcodeTools,
  getVibeCallRun,
  inspectThoughtcodeRun,
  vibeCallTool,
  vibeReturnTool,
} from "../dist/index.js";

const SCRATCH_DIR = "/tmp/agentic_coding";
const vibeCallArgs = (program_file_path: string, name: string, args: string): VibeCallArgs => ({
  program_file_path,
  name,
  args,
});
const vibePrompt = (program_file_path: string, name: string, args: string): string =>
  buildVibeCallSubagentPrompt(vibeCallArgs(program_file_path, name, args));
const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

async function renderInspect(runId: string, width = 220): Promise<string> {
  let rendered = "";

  await inspectThoughtcodeRun(runId, {
    mode: "tui",
    ui: {
      async custom(factory: never) {
        const component = (factory as (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => {
          render(width: number): string[];
        })(
          { terminal: { rows: 32 }, requestRender() {} },
          plainTheme,
          {},
          () => {},
        );
        rendered = component.render(width).join("\n");
      },
      notify() {
        throw new Error("inspect should not notify for an existing run");
      },
    },
  } as never);

  return rendered;
}

describe("pi-thoughtcode", () => {
  beforeEach(() => {
    clearVibeCallRunsForTests();
  });

  it("exports the two Thoughtcode placeholder tools", () => {
    const tools = createThoughtcodeTools();

    expect(tools.map((tool) => tool.name)).toEqual(["VIBECALL", "VIBERETURN"]);
    expect(vibeCallTool.parameters.required).toEqual(VIBE_CALL_TOOL_PARAMETERS.map((parameter) => parameter.name));
    expect(vibeReturnTool.parameters.required).toEqual(VIBE_RETURN_TOOL_PARAMETERS.map((parameter) => parameter.name));
    for (const parameter of VIBE_CALL_TOOL_PARAMETERS) {
      expect(vibeCallTool.parameters.properties[parameter.name]?.description).toBe(parameter.description);
    }
    for (const parameter of VIBE_RETURN_TOOL_PARAMETERS) {
      expect(vibeReturnTool.parameters.properties[parameter.name]?.description).toBe(parameter.description);
    }
  });

  it("registers tools through the PI extension factory", () => {
    const registered: ToolDefinition[] = [];
    const commands: string[] = [];

    thoughtcodeExtension({
      registerTool(tool) {
        registered.push(tool);
      },
      registerCommand(name) {
        commands.push(name);
      },
    } as never);

    expect(registered.map((tool) => tool.name)).toEqual(["VIBECALL", "VIBERETURN"]);
    expect(commands).toEqual(["thoughtcode-inspect"]);
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
    const expectedPrompt = vibePrompt("./program.txt", "mul", "a=3,my number=9");
    const [vibeCall] = createThoughtcodeTools({
      async runSubagent(request) {
        expect(request.call).toEqual({
          program_file_path: "./program.txt",
          name: "mul",
          args: "a=3,my number=9",
        });
        expect(request.prompt).toBe(expectedPrompt);
        expect(request.depth).toBe(1);
        expect(request.progress).toMatchObject({ status: "run", depth: 1, step: "think" });
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
      runId: "tc-1",
      program_file_path: "./program.txt",
      name: "mul",
      args: "a=3,my number=9",
      prompt: expectedPrompt,
      status: "done",
      depth: 1,
      progress: expect.objectContaining({
        status: "done",
        depth: 1,
        step: "done 27",
      }),
      events: [
        expect.objectContaining({ type: "thinking", text: "thinking" }),
        expect.objectContaining({ type: "return", text: "done 27" }),
      ],
      transcript: [
        expect.objectContaining({ role: "return", text: "27" }),
      ],
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

  it("renders a concise VIBECALL progress card", () => {
    const component = vibeCallTool.renderResult?.(
      {
        content: [{ type: "text", text: "tool read /tmp/agentic_coding/program.tc" }],
        details: {
          kind: "vibecall",
          runId: "tc-7",
          program_file_path: "/tmp/agentic_coding/program.tc",
          name: "main",
          args: 'x=2,y=5, payload={"items":[1,2,3,4,5,6]}',
          prompt: vibePrompt("/tmp/agentic_coding/program.tc", "main", "x=2,y=5"),
          status: "running",
          depth: 1,
          progress: {
            status: "run",
            depth: 1,
            startedAt: 0,
            endedAt: 6000,
            step: "tool read /tmp/agentic_coding/program.tc",
            usage: {
              input: 815,
              output: 87,
              cacheRead: 565,
              cacheWrite: 0,
              cost: 0.0001,
            },
          },
        },
      },
      { expanded: false, isPartial: true },
      plainTheme as never,
      { cwd: "/tmp/agentic_coding" } as never,
    );

    const output = component?.render(160).join("\n") ?? "";

    expect(output).toContain("VIBECALL running 6s depth=1 run=tc-7 ↑815 ↓87 R565 $0.00010");
    expect(output).toContain("entry main");
    expect(output).toContain("file program.tc");
    expect(output).toContain('args x=2,y=5, payload={"items":[1,2,3,4,5,6]}');
    expect(output).toContain("tool read program.tc");
    expect(output).not.toContain("d1");
    expect(output).not.toContain("run 6s d1");
    expect(output).not.toContain("activity");
    expect(output).not.toContain("return:");
  });

  it("renders empty VIBECALL args and thinking state explicitly", () => {
    const component = vibeCallTool.renderResult?.(
      {
        content: [{ type: "text", text: "think" }],
        details: {
          kind: "vibecall",
          runId: "tc-8",
          program_file_path: "./program1.txt",
          name: "main",
          args: "",
          prompt: vibePrompt("./program1.txt", "main", ""),
          status: "running",
          depth: 1,
          progress: {
            status: "run",
            depth: 1,
            startedAt: 0,
            endedAt: 6000,
            step: "think",
          },
        },
      },
      { expanded: false, isPartial: true },
      plainTheme as never,
      { cwd: "/tmp/agentic_coding" } as never,
    );

    const output = component?.render(120).join("\n") ?? "";
    const lines = output.split("\n").map((line) => line.trimEnd());

    expect(output).toContain("VIBECALL running 6s depth=1 run=tc-8");
    expect(output).toContain("entry main");
    expect(output).toContain("file ./program1.txt");
    expect(output).toContain("args <empty>");
    expect(lines).toContain("thinking");
    expect(lines).not.toContain("think");
    expect(output).not.toContain("d1");
  });

  it("opens a read-only inspector overlay for a VIBECALL run", async () => {
    const [vibeCall] = createThoughtcodeTools({
      async runSubagent() {
        return "27";
      },
    });
    const callResult = await vibeCall.execute(
      "call-1",
      { program_file_path: "./program.txt", name: "mul", args: "a=3,my number=9" },
      undefined,
      undefined,
      { cwd: "/tmp/agentic_coding" } as never,
    );
    const rendered = await renderInspect(callResult.details.runId);

    expect(rendered).toContain("Thoughtcode tc-1 done");
    expect(rendered).toContain("entry mul");
    expect(rendered).toContain("file ./program.txt");
    expect(rendered).toContain("args a=3,my number=9");
    for (const line of buildVibeCallSubagentPrompt(callResult.details).split("\n")) {
      expect(rendered).toContain(line);
    }
    expect(rendered).toContain("Return");
    expect(rendered).toContain("27");
    expect(rendered).not.toContain("return done 27");
    expect(rendered).not.toContain("thinking thinking");
  });

  it("renders a missing VIBERETURN failure once in the inspector", async () => {
    const [vibeCall] = createThoughtcodeTools({
      async runSubagent(request) {
        request.progress.status = "fail";
        request.progress.endedAt = Date.now();
        request.progress.step = "fail missing VIBERETURN";
        throw new Error("Finished without calling VIBERETURN.");
      },
    });
    const callResult = await vibeCall.execute(
      "call-1",
      { program_file_path: "./program.txt", name: "mul", args: "a=3,my number=9" },
      undefined,
      undefined,
      { cwd: "/tmp/agentic_coding" } as never,
    );
    const rendered = await renderInspect(callResult.details.runId);

    expect(callResult.details.status).toBe("error");
    expect(rendered).toContain("Thoughtcode tc-1 failed");
    expect(rendered).not.toContain("missing VIBERETURN");
    expect(rendered.match(/Finished without calling VIBERETURN\./g)?.length).toBe(1);
  });

  it("captures child-session reasoning and VIBERETURN in the inspector transcript", async () => {
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
          reasoning: true,
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
      fauxAssistantMessage([fauxThinking("Need to return the computed value."), fauxToolCall("VIBERETURN", { value: "27" })], {
        stopReason: "toolUse",
      }),
    ]);

    try {
      const [vibeCall] = createThoughtcodeTools();
      const result = await vibeCall.execute(
        "call-1",
        {
          program_file_path: "./program.txt",
          name: "mul",
          args: "a=3,my number=9",
        },
        undefined,
        undefined,
        {
          cwd,
          model,
          modelRegistry,
        } as never,
      );
      const run = getVibeCallRun(result.details.runId);
      const rendered = await renderInspect(result.details.runId, 100);

      expect(result.content).toEqual([{ type: "text", text: "27" }]);
      expect(run?.transcript).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "thinking", text: "Need to return the computed value." }),
        expect.objectContaining({ role: "tool", text: "VIBERETURN 27" }),
        expect.objectContaining({ role: "return", text: "27" }),
      ]));
      expect(rendered).toContain("Reasoning");
      expect(rendered).toContain("Need to return the computed value.");
      expect(rendered).toContain("Tool");
      expect(rendered).toContain("VIBERETURN 27");
      expect(rendered).not.toContain("Thinking...");
      expect(faux.state.callCount).toBe(1);
      expect(faux.getPendingResponseCount()).toBe(0);
    } finally {
      faux.unregister();
    }
  });

  it("shows nested VIBECALL run ids in the parent inspector transcript", async () => {
    const faux = registerFauxProvider({
      api: "thoughtcode-nested-faux-api",
      provider: "thoughtcode-nested-faux",
      models: [{ id: "thoughtcode-nested-faux-model" }],
    });
    const cwd = await mkdtemp(join(SCRATCH_DIR, "thoughtcode-cwd-"));
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey("thoughtcode-nested-faux", "test-key");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const streamSimple = getApiProvider(faux.api)?.streamSimple;

    if (!streamSimple) {
      throw new Error("Faux provider did not register a stream.");
    }

    modelRegistry.registerProvider("thoughtcode-nested-faux", {
      api: faux.api,
      apiKey: "test-key",
      baseUrl: "http://localhost:0",
      streamSimple,
      models: [
        {
          id: "thoughtcode-nested-faux-model",
          name: "Thoughtcode Nested Faux Model",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    });
    const model = modelRegistry.find("thoughtcode-nested-faux", "thoughtcode-nested-faux-model");

    if (!model) {
      throw new Error("Registered faux model was not found.");
    }

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("VIBECALL", {
          program_file_path: "./program.txt",
          name: "inner",
          args: "x=1",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("VIBERETURN", { value: "inner-result" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("VIBERETURN", { value: "outer-result" }), {
        stopReason: "toolUse",
      }),
    ]);

    try {
      const [vibeCall] = createThoughtcodeTools();
      const result = await vibeCall.execute(
        "call-1",
        {
          program_file_path: "./program.txt",
          name: "outer",
          args: "",
        },
        undefined,
        undefined,
        {
          cwd,
          model,
          modelRegistry,
        } as never,
      );
      const parentRun = getVibeCallRun(result.details.runId);
      const rendered = await renderInspect(result.details.runId, 120);

      expect(result.content).toEqual([{ type: "text", text: "outer-result" }]);
      expect(getVibeCallRun("tc-2")).toBeDefined();
      expect(parentRun?.transcript).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", text: "VIBECALL run=tc-2 inner x=1" }),
        expect.objectContaining({ role: "return", text: "outer-result" }),
      ]));
      expect(rendered).toContain("VIBECALL run=tc-2 inner x=1");
    } finally {
      faux.unregister();
    }
  });
});
