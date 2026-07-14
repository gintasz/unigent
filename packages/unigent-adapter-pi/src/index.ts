import { basename } from "node:path";
import process from "node:process";
import {
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  Agent as PiCoreAgent,
  type AgentEvent as PiEvent,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type Extension,
  getAgentDir,
  type LoadExtensionsResult,
  ModelRegistry,
  type ResourceDiagnostic,
  type ResourceLoader,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  AgentBackendRejectedError,
  AgentBackendUnavailableError,
  AgentCancelledError,
  AgentConfigError,
  type Backend,
  type BackendEvent,
  type BackendSession,
  type BackendSessionOptions,
  type BackendTool,
  type BackendTurnRequest,
  type BackendTurnResult,
  type BackendUsage,
} from "@unigent/core";
import { Type } from "typebox";

/** Pi machine-resource policy. Clean keeps auth/models/native tools but omits prompt/plugins/skills. */
type PiBase = "clean" | "machine";

/** Construction options for the Pi backend. */
interface PiAgentOptions {
  readonly base?: PiBase;
  readonly nativeTools?: readonly string[];
  readonly plugins?: readonly string[];
  readonly skills?: readonly string[];
  readonly streamFn?: StreamFn;
  readonly resolveModel?: (modelId: string) => Model<Api> | undefined;
  readonly basePrompt?: string;
  readonly tools?: readonly AgentTool[];
  /** Explicit identity for checkpoint invalidation when injected resources change. */
  readonly checkpointKey?: string;
}

interface PiWiring {
  readonly streamFn: StreamFn;
  readonly registry?: ModelRegistry;
  readonly basePrompt: string | undefined;
  readonly nativeTools: readonly AgentTool[];
}

const PI_THINKING: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const FILE_EXTENSION = /\.[^.]+$/;

function thinkingLevel(value: string | undefined): ThinkingLevel {
  if (value === undefined) {
    return "off";
  }
  if (!PI_THINKING.has(value)) {
    throw new AgentConfigError(`unsupported Pi thinking level: ${value}`);
  }
  return value as ThinkingLevel;
}

function validateAllowlist(
  category: string,
  requested: readonly string[] | undefined,
  available: readonly string[],
): void {
  if (requested === undefined) {
    return;
  }
  const known = new Set(available);
  const missing = requested.filter((name) => !known.has(name));
  if (missing.length > 0) {
    throw new AgentConfigError(`unknown Pi ${category}: ${missing.join(", ")}`);
  }
}

function toolDescription(tool: BackendTool): string {
  return tool.description;
}

function toPiTool(tool: BackendTool): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: toolDescription(tool),
    parameters: Type.Unsafe(tool.parameters),
    execute: async (_id: string, input: unknown): Promise<AgentToolResult<unknown>> => {
      const result = await tool.execute(input);
      if (result.isError) {
        throw new Error(result.content);
      }
      const content: TextContent[] = [{ type: "text", text: result.content }];
      return result.terminate === true
        ? { content, details: {}, terminate: true }
        : { content, details: {} };
    },
  };
}

function resultText(result: unknown): string {
  const content = (result as { readonly content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part: unknown): part is TextContent =>
        typeof part === "object" && part !== null && "type" in part && part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function eventFromPi(event: PiEvent): BackendEvent | undefined {
  switch (event.type) {
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        return { type: "text", text: update.delta };
      }
      if (update.type === "thinking_delta") {
        return { type: "reasoning", text: update.delta };
      }
      return;
    }
    case "tool_execution_start":
      return {
        type: "tool_call",
        callId: event.toolCallId,
        name: event.toolName,
        input: event.args,
      };
    case "tool_execution_end":
      return {
        type: "tool_result",
        callId: event.toolCallId,
        name: event.toolName,
        output: resultText(event.result),
        isError: event.isError,
      };
    default:
      return;
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function addUsage(total: BackendUsage, usage: Usage): BackendUsage {
  return {
    inputTokens: total.inputTokens + usage.input,
    outputTokens: total.outputTokens + usage.output,
    totalTokens: total.totalTokens + usage.totalTokens,
    cachedInputTokens: (total.cachedInputTokens ?? 0) + usage.cacheRead,
    costUsd: (total.costUsd ?? 0) + usage.cost.total,
  };
}

function collectResult(messages: readonly AgentMessage[]): BackendTurnResult {
  let text = "";
  let usage: BackendUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    if (message.stopReason === "error") {
      throw new AgentBackendUnavailableError(message.errorMessage ?? "Pi model error");
    }
    text = assistantText(message);
    usage = addUsage(usage, message.usage);
  }
  return { text, usage };
}

function pluginName(extension: Extension): string {
  return (
    (extension.sourceInfo as { readonly source?: string } | undefined)?.source ??
    basename(extension.resolvedPath).replace(FILE_EXTENSION, "")
  );
}

async function resourceLoader(options: PiAgentOptions): Promise<ResourceLoader> {
  const base = options.base ?? "clean";
  const skills = options.skills ?? (base === "clean" ? [] : undefined);
  const plugins = options.plugins ?? (base === "clean" ? [] : undefined);
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    ...(skills !== undefined && skills.length === 0 ? { noSkills: true } : {}),
    ...(skills !== undefined && skills.length > 0
      ? {
          skillsOverride: (loaded: {
            skills: Skill[];
            diagnostics: ResourceDiagnostic[];
          }): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } => {
            validateAllowlist(
              "skill",
              skills,
              loaded.skills.map((skill) => skill.name),
            );
            return {
              ...loaded,
              skills: loaded.skills.filter((skill): boolean => skills.includes(skill.name)),
            };
          },
        }
      : {}),
    ...(plugins !== undefined && plugins.length === 0 ? { noExtensions: true } : {}),
    ...(plugins !== undefined && plugins.length > 0
      ? {
          extensionsOverride: (loaded: LoadExtensionsResult): LoadExtensionsResult => {
            validateAllowlist("plugin", plugins, loaded.extensions.map(pluginName));
            return {
              ...loaded,
              extensions: loaded.extensions.filter((extension): boolean =>
                plugins.includes(pluginName(extension)),
              ),
            };
          },
        }
      : {}),
  });
  await loader.reload();
  return loader;
}

function resolveModel(registry: ModelRegistry | undefined, id: string): Model<Api> | undefined {
  const separator = id.indexOf("/");
  const provider = separator < 0 ? id : id.slice(0, separator);
  const name = separator < 0 ? id : id.slice(separator + 1);
  return registry?.find(provider, name);
}

async function buildWiring(options: PiAgentOptions): Promise<PiWiring> {
  if (options.streamFn !== undefined) {
    if ((options.plugins?.length ?? 0) > 0 || (options.skills?.length ?? 0) > 0) {
      throw new AgentConfigError(
        "injected Pi streamFn cannot load plugins or skills; inject their resulting tools explicitly",
      );
    }
    return {
      streamFn: options.streamFn,
      basePrompt: options.basePrompt,
      nativeTools: options.tools ?? [],
    };
  }
  const registry = ModelRegistry.create(AuthStorage.create());
  registry.refresh();
  const loader = await resourceLoader(options);
  const seed = registry.getAvailable()[0] ?? registry.getAll()[0];
  const { session } = await createAgentSession({
    modelRegistry: registry,
    resourceLoader: loader,
    ...(seed === undefined ? {} : { model: seed }),
  });
  return {
    streamFn: session.agent.streamFn,
    registry,
    basePrompt: options.basePrompt ?? session.agent.state.systemPrompt,
    nativeTools: options.tools ?? session.agent.state.tools,
  };
}

function selectNativeTools(wiring: PiWiring, allowed: readonly string[] | undefined): AgentTool[] {
  return wiring.nativeTools.filter(
    (tool): boolean => allowed === undefined || allowed.includes(tool.name),
  );
}

function makeSession(
  wiring: PiWiring,
  model: Model<Api>,
  options: PiAgentOptions,
  seed: readonly AgentMessage[] = [],
): BackendSession {
  let active: PiCoreAgent | undefined;
  const ensureAgent = (
    systemPrompt: string,
    thinking: ThinkingLevel,
    tools: AgentTool[],
  ): PiCoreAgent => {
    if (active === undefined) {
      active = new PiCoreAgent({
        initialState: { systemPrompt, model, thinkingLevel: thinking, tools },
        streamFn: wiring.streamFn,
        convertToLlm: (messages: AgentMessage[]): Message[] =>
          messages.filter(
            (message): message is Message =>
              message.role === "user" ||
              message.role === "assistant" ||
              message.role === "toolResult",
          ),
      });
      active.state.messages = [...seed];
      return active;
    }
    active.state.systemPrompt = systemPrompt;
    active.state.thinkingLevel = thinking;
    active.state.tools = tools;
    return active;
  };
  return {
    runTurn: async (request: BackendTurnRequest): Promise<BackendTurnResult> => {
      const includeBase =
        (options.base ?? "clean") === "machine" && request.systemPromptMode === "append";
      const systemPrompt =
        includeBase && wiring.basePrompt !== undefined
          ? `${wiring.basePrompt}\n\n${request.systemPrompt}`
          : request.systemPrompt;
      const native = selectNativeTools(wiring, options.nativeTools);
      const piTools = [...native, ...request.tools.map(toPiTool)];
      const agent = ensureAgent(systemPrompt, thinkingLevel(request.thinking), piTools);
      if (request.signal.aborted) {
        throw new AgentCancelledError("Pi run was cancelled");
      }
      const onAbort = (): void => agent.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      const unsubscribe = agent.subscribe((event) => {
        const normalized = eventFromPi(event);
        if (normalized !== undefined) {
          request.onEvent(normalized);
        }
      });
      const before = agent.state.messages.length;
      try {
        await agent.prompt(request.prompt);
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        unsubscribe();
      }
      return collectResult(agent.state.messages.slice(before));
    },
    fork: (): BackendSession =>
      makeSession(wiring, model, options, [...(active?.state.messages ?? seed)]),
  };
}

/** Create the Pi agent-SDK backend. */
export function piAgent(options: PiAgentOptions = {}): Backend {
  let wiringPromise: Promise<PiWiring> | undefined;
  const wiring = async (): Promise<PiWiring> => {
    const pending = wiringPromise ?? buildWiring(options);
    wiringPromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (wiringPromise === pending) {
        wiringPromise = undefined;
      }
      throw error;
    }
  };
  return {
    name: "pi",
    checkpointKey:
      options.checkpointKey ??
      JSON.stringify({
        adapter: "pi-v1",
        base: options.base ?? "clean",
        nativeTools: options.nativeTools,
        plugins: options.plugins,
        skills: options.skills,
        basePrompt: options.basePrompt,
        injectedStream: options.streamFn !== undefined,
        injectedTools: options.tools?.map((tool) => tool.name),
      }),
    capabilities: {
      reportsCost: true,
      supportsSessionFork: true,
    },
    openSession: async ({ model: modelId }: BackendSessionOptions): Promise<BackendSession> => {
      const resolvedWiring = await wiring();
      validateAllowlist(
        "native tool",
        options.nativeTools,
        resolvedWiring.nativeTools.map((tool) => tool.name),
      );
      const model =
        options.resolveModel?.(modelId) ?? resolveModel(resolvedWiring.registry, modelId);
      if (model === undefined) {
        throw new AgentBackendRejectedError(`unknown Pi model: ${modelId}`);
      }
      return makeSession(resolvedWiring, model, options);
    },
  };
}

export type { PiAgentOptions, PiBase };
