import {
  type AgentToolResult,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  VIBE_CALL_TOOL_DESCRIPTION,
  VIBE_RETURN_TOOL_DESCRIPTION,
  buildVibeCallSubagentPrompt,
  type VibeCallArgs,
  type VibeReturnArgs,
} from "thoughtcode-core";
import { Type, type Static } from "typebox";

const vibeCallParameters = Type.Object({
  program_file_path: Type.String({
    description: "Path to the Thoughtcode program file the subagent must read.",
  }),
  name: Type.String({
    description: "Name of the Thoughtcode VIBEMETHOD to call.",
  }),
  args: Type.String({
    description: "Serialized arguments for the target VIBEMETHOD.",
  }),
});

const vibeReturnParameters = Type.Object({
  value: Type.String({
    description: "Serialized return value for the current Thoughtcode VIBEMETHOD.",
  }),
});

type VibeCallParams = Static<typeof vibeCallParameters>;
type VibeReturnParams = Static<typeof vibeReturnParameters>;

export interface VibeCallDetails {
  kind: "vibecall";
  program_file_path: string;
  name: string;
  args: string;
  prompt: string;
  status: "done" | "error" | "aborted";
  result?: string;
  error?: string;
}

export interface VibeReturnDetails {
  kind: "vibereturn";
  value: string;
}

export interface VibeSubagentRunRequest {
  toolCallId: string;
  call: VibeCallArgs;
  prompt: string;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
}

export type VibeSubagentRunner = (request: VibeSubagentRunRequest) => Promise<string>;

export interface ThoughtcodeToolOptions {
  runSubagent?: VibeSubagentRunner;
  onVibeReturn?: (value: string) => void;
}

function textResult<TDetails>(text: string, details: TDetails, terminate = false): AgentToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    details,
    terminate,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getTextContent(content: AgentToolResult<unknown>["content"]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function createVibeCallTool(options: ThoughtcodeToolOptions = {}) {
  const runSubagent = options.runSubagent ?? runThoughtcodeSubagent;

  return defineTool({
    ...VIBE_CALL_TOOL_DESCRIPTION,
    parameters: vibeCallParameters,
    executionMode: "parallel",
    async execute(
      toolCallId,
      params: VibeCallParams,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<VibeCallDetails>> {
      const call: VibeCallArgs = {
        program_file_path: params.program_file_path,
        name: params.name,
        args: params.args,
      };
      const prompt = buildVibeCallSubagentPrompt(call);

      try {
        const value = await runSubagent({
          toolCallId,
          call,
          prompt,
          ctx,
          signal,
        });

        return textResult(value, {
          kind: "vibecall",
          program_file_path: call.program_file_path,
          name: call.name,
          args: call.args,
          prompt,
          status: "done",
          result: value,
        });
      } catch (error) {
        const status = signal?.aborted ? "aborted" : "error";
        return textResult(`VIBECALL ${status}: ${getErrorMessage(error)}`, {
          kind: "vibecall",
          program_file_path: call.program_file_path,
          name: call.name,
          args: call.args,
          prompt,
          status,
          error: getErrorMessage(error),
        });
      }
    },
  });
}

export function createVibeReturnTool(options: ThoughtcodeToolOptions = {}) {
  return defineTool({
    ...VIBE_RETURN_TOOL_DESCRIPTION,
    parameters: vibeReturnParameters,
    async execute(_toolCallId, params: VibeReturnParams): Promise<AgentToolResult<VibeReturnDetails>> {
      const args: VibeReturnArgs = {
        value: params.value,
      };

      if (!options.onVibeReturn) {
        return textResult(
          `VIBERETURN ignored outside VIBECALL subagent: ${args.value}`,
          {
            kind: "vibereturn",
            value: args.value,
          },
          false,
        );
      }

      options.onVibeReturn(args.value);

      return textResult(
        args.value,
        {
          kind: "vibereturn",
          value: args.value,
        },
        true,
      );
    },
  });
}

export async function runThoughtcodeSubagent(request: VibeSubagentRunRequest): Promise<string> {
  const { ctx, signal } = request;
  const model = ctx.model;

  if (!model) {
    throw new Error("Cannot spawn Thoughtcode subagent: no PI model is selected.");
  }

  let returnedValue: string | undefined;
  let subagentError: string | undefined;
  const childTools = createThoughtcodeTools({
    onVibeReturn: (value) => {
      returnedValue = value;
    },
  });
  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRegistry: ctx.modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    customTools: [...childTools],
    tools: ["read", "VIBECALL", "VIBERETURN"],
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end") {
      return;
    }
    if (event.message.role === "assistant" && event.message.stopReason === "error") {
      subagentError = event.message.errorMessage ?? "Thoughtcode subagent failed.";
      return;
    }
    if (event.message.role !== "toolResult") {
      return;
    }
    if (event.message.toolName !== "VIBERETURN") {
      return;
    }
    const details = event.message.details as Partial<VibeReturnDetails> | undefined;
    returnedValue = typeof details?.value === "string" ? details.value : getTextContent(event.message.content);
  });

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      void session.abort();
    };
    if (!signal.aborted) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  try {
    if (signal?.aborted) {
      throw new Error("Thoughtcode subagent aborted before prompt start.");
    }

    await session.bindExtensions({});

    if (signal?.aborted) {
      throw new Error("Thoughtcode subagent aborted before prompt start.");
    }

    await session.prompt(request.prompt, {
      expandPromptTemplates: false,
      source: "extension",
    });

    if (returnedValue === undefined) {
      if (subagentError) {
        throw new Error(subagentError);
      }
      throw new Error("Thoughtcode subagent finished without calling VIBERETURN.");
    }

    return returnedValue;
  } finally {
    unsubscribe();
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    session.dispose();
  }
}

export const vibeCallTool = createVibeCallTool();

export const vibeReturnTool = createVibeReturnTool();

export function createThoughtcodeTools(options: ThoughtcodeToolOptions = {}) {
  return [createVibeCallTool(options), createVibeReturnTool(options)] as const;
}

const thoughtcodeExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  for (const tool of createThoughtcodeTools()) {
    pi.registerTool(tool);
  }
};

export default thoughtcodeExtension;
