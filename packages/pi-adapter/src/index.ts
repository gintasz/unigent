// The pi harness adapter: the sole binding between core's harness port
// (OpenSession/HarnessSession) and pi's runtime. microfoom programs run as a
// programmatic pi agent: each turn drives a pi-agent-core `Agent` whose loop owns
// the model calls and EXECUTES the FOOM tools (ADR-0002 rev). Core supplies the
// neutral tool semantics + the turn coordinator; this maps them ↔ pi. The
// configured stream function (model + auth + providers from ~/.pi) is obtained
// from pi's own `createAgentSession`. Consumed by the CLI (and any future
// frontend); it carries no extension/TUI concerns of its own.

import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type AgentEvent as PiAgentEvent,
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
  FoomtimeHarnessRejectedError,
  FoomtimeHarnessUnavailableError,
  type HarnessSession,
  type NeutralToolDef,
  type OpenSession,
  type SessionTurnRequest,
  type SessionTurnResult,
  type StreamEvent,
  type UsageDelta,
} from "@microfoom/core";
import { Type } from "typebox";

export const PI_HARNESS_VERSION = "0.0.0";

const PI_THINKING: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

// The per-turn Agent is raw pi-agent-core (no promptSnippet/promptGuidelines slot
// — those are a pi-coding-agent system-prompt feature, and microfoom runs a
// controlled session, not pi's auto-prompt). So fold a tool's snippet/guidelines
// into the one model-native field this layer has: the description.
function toolDescription(tool: NeutralToolDef): string {
  const parts = [tool.description];
  if (tool.promptSnippet !== undefined) parts.push(tool.promptSnippet);
  if (tool.promptGuidelines !== undefined && tool.promptGuidelines.length > 0) {
    parts.push(["Guidelines:", ...tool.promptGuidelines.map((rule) => `- ${rule}`)].join("\n"));
  }
  return parts.join("\n\n");
}

function toAgentTool(tool: NeutralToolDef): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: toolDescription(tool),
    parameters: Type.Unsafe(tool.parameters as Record<string, unknown>),
    execute: async (_id: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      const result = await tool.execute(params);
      const content: TextContent[] = [{ type: "text", text: result.content }];
      return result.terminate === true
        ? { content, details: {}, terminate: true }
        : { content, details: {} };
    },
  };
}

const truncate = (text: string): string => (text.length > 500 ? `${text.slice(0, 500)}…` : text);

/**
 * Append a structured JSONL record of one model turn (prompt, advertised tools,
 * and the assistant/tool messages it produced) to `logFile`. Best-effort and
 * bounded (OB1) — never throws into the run. Enabled via `logFile` or
 * `MICROFOOM_LOG`; the main lever for seeing what the model actually did.
 */
function logTurn(
  logFile: string | undefined,
  model: string,
  request: SessionTurnRequest,
  newMessages: readonly AgentMessage[],
  tools: readonly AgentTool[],
): void {
  if (logFile === undefined) return;
  const messages = newMessages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        content: message.content.map((part) =>
          part.type === "text"
            ? { text: truncate(part.text) }
            : part.type === "toolCall"
              ? { toolCall: { name: part.name, arguments: part.arguments } }
              : { thinking: true },
        ),
      };
    }
    if (message.role === "toolResult") {
      return { role: "toolResult", toolName: message.toolName, isError: message.isError };
    }
    return { role: message.role };
  });
  const record = {
    ts: new Date().toISOString(),
    model,
    prompt: truncate(request.prompt),
    tools: tools.map((tool) => tool.name),
    messages,
  };
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(record)}\n`);
  } catch {
    // Logging never breaks a run (OB1).
  }
}

/** Flatten a pi tool result's content blocks to the text shown in a transcript. */
function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is TextContent =>
        typeof part === "object" && part !== null && (part as TextContent).type === "text",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * Translate one pi `Agent` lifecycle event into a microfoom `StreamEvent` (or
 * undefined to drop it). This is the transcript bridge: assistant prose/reasoning
 * deltas and tool call/result boundaries flow to the run's frontend; pi's
 * bookkeeping events (turn_start, agent_start/end) are dropped.
 */
function toStreamEvent(event: PiAgentEvent): StreamEvent | undefined {
  switch (event.type) {
    case "message_start":
      return { type: "message_start" };
    case "message_end":
      return { type: "message_end" };
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") return { type: "text", delta: update.delta };
      if (update.type === "thinking_delta") return { type: "reasoning", delta: update.delta };
      return undefined;
    }
    case "tool_execution_start":
      return {
        type: "tool_call",
        callId: event.toolCallId,
        name: event.toolName,
        args: event.args,
      };
    case "tool_execution_end":
      return {
        type: "tool_result",
        callId: event.toolCallId,
        content: toolResultText(event.result),
        isError: event.isError,
      };
    default:
      return undefined;
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function addUsage(into: UsageDelta, usage: Usage): UsageDelta {
  return {
    inputTokens: into.inputTokens + usage.input,
    outputTokens: into.outputTokens + usage.output,
    totalTokens: into.totalTokens + usage.totalTokens,
    cachedInputTokens: (into.cachedInputTokens ?? 0) + usage.cacheRead,
    costUsd: (into.costUsd ?? 0) + usage.cost.total,
  };
}

/** Overrides for testing or custom wiring; defaults resolve from ~/.pi. */
export interface PiSessionOptions {
  /** Resolve a model id ("provider/id") to a pi Model. Default: ModelRegistry. */
  readonly resolveModel?: (modelId: string) => Model<Api> | undefined;
  /** Inject a stream function (tests). Default: pi's configured one via createAgentSession. */
  readonly streamFn?: StreamFn;
  /** Append a JSONL record of each turn here. Default: `process.env.MICROFOOM_LOG`. */
  readonly logFile?: string;
  /**
   * Drop pi's base system prompt — send the model ONLY microfoom's prompt (runtime
   * block + the program's own systemPrompt). Default false: pi's base (coding-agent
   * persona + project context) is prepended, AGENTS.md-style.
   */
  readonly omitHarnessBasePrompt?: boolean;
  /** Override the base system prompt (tests / custom wiring). Default: pi's configured base. */
  readonly basePrompt?: string;
  /** Override the harness tool suite (tests / custom wiring). Default: pi's configured tools. */
  readonly tools?: readonly AgentTool[];
}

interface PiRuntime {
  readonly streamFn: StreamFn;
  readonly registry?: ModelRegistry;
  /** pi's configured base system prompt (persona + project context); microfoom's
   *  program prompt is appended to it, AGENTS.md-style. undefined when omitted (or
   *  an injected streamFn with no base), so the program prompt is sent verbatim. */
  readonly basePrompt?: string | undefined;
  /** pi's default tools (read/bash/edit/…) advertised to the model alongside the
   *  FOOM tools, so the harness persona's claimed capabilities are real. undefined
   *  in bare mode (omitHarnessBasePrompt) — then only the FOOM tools are offered. */
  readonly harnessTools?: readonly AgentTool[] | undefined;
}

/** Append the program's system prompt to the harness base (AGENTS.md-style). */
function composeSystemPrompt(base: string | undefined, programPrompt: string): string {
  return base !== undefined && base.length > 0 ? `${base}\n\n${programPrompt}` : programPrompt;
}

/** A plugin's stable identifier for `allowedPlugins` matching: pi's source name,
 *  falling back to the extension file's basename. */
function pluginName(ext: Extension): string {
  return ext.sourceInfo?.source ?? basename(ext.resolvedPath).replace(/\.[^.]+$/, "");
}

/**
 * A resource loader filtered to the allowed skills/plugins, or `undefined` when
 * neither is constrained (so callers inherit pi's default loading untouched).
 * Tri-state per axis: `undefined` = all, `[]` = none (`noSkills`/`noExtensions`),
 * a list = keep only matching members.
 */
async function buildResourceLoader(
  allowedSkills: readonly string[] | undefined,
  allowedPlugins: readonly string[] | undefined,
): Promise<ResourceLoader | undefined> {
  if (allowedSkills === undefined && allowedPlugins === undefined) return undefined;

  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    ...(allowedSkills !== undefined && allowedSkills.length === 0 ? { noSkills: true } : {}),
    ...(allowedSkills !== undefined && allowedSkills.length > 0
      ? {
          skillsOverride: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => ({
            ...base,
            skills: base.skills.filter((skill) => allowedSkills.includes(skill.name)),
          }),
        }
      : {}),
    ...(allowedPlugins !== undefined && allowedPlugins.length === 0 ? { noExtensions: true } : {}),
    ...(allowedPlugins !== undefined && allowedPlugins.length > 0
      ? {
          extensionsOverride: (base: LoadExtensionsResult) => ({
            ...base,
            extensions: base.extensions.filter((ext) => allowedPlugins.includes(pluginName(ext))),
          }),
        }
      : {}),
  });
  await loader.reload();
  return loader;
}

/** A stable cache key for one (allowedSkills, allowedPlugins) pair. `*` = all
 *  (undefined), `-` = none ([]), else the sorted names — so the tri-state and order
 *  don't spawn redundant runtimes. */
function runtimeKey(
  allowedSkills: readonly string[] | undefined,
  allowedPlugins: readonly string[] | undefined,
): string {
  const ser = (v: readonly string[] | undefined): string =>
    v === undefined ? "*" : v.length === 0 ? "-" : [...v].sort().join(",");
  return `${ser(allowedSkills)}|${ser(allowedPlugins)}`;
}

/**
 * Build an `OpenSession` backed by pi — the harness port you hand to
 * `runProgram`. Resolves models + auth from `~/.pi` and obtains pi's configured
 * stream function from `createAgentSession` (done once, lazily). Each microfoom
 * turn drives a pi `Agent` whose loop runs the FOOM tools; a `session()` reuses one
 * Agent (continued transcript), a stateless turn opens a fresh one.
 *
 * @param options - Overrides for testing or custom wiring; see {@link PiSessionOptions}.
 *   Defaults resolve from `~/.pi`.
 * @returns An `OpenSession` to register under a name in `runProgram`'s `harnesses`.
 * @example
 * ```ts
 * const result = await runProgram(MyProgram, input, {
 *   harnesses: { pi: createPiOpenSession() },
 *   model: "openrouter/deepseek/deepseek-v4-flash",
 * });
 * ```
 */
export function createPiOpenSession(options: PiSessionOptions = {}): OpenSession {
  const logFile = options.logFile ?? process.env.MICROFOOM_LOG;

  // `omitHarnessBasePrompt` drops pi's base PROMPT only (persona/context). Which
  // tools are exposed is independent — controlled per-turn by request.allowedTools.
  // An explicit option override wins over pi's configured values (for tests).
  const resolveBase = (piBase: string | undefined): string | undefined =>
    options.omitHarnessBasePrompt === true ? undefined : (options.basePrompt ?? piBase);
  const resolveTools = (piTools: readonly AgentTool[] | undefined) => options.tools ?? piTools;

  // skills/plugins arrive PER session-open (resolved from the scope's merged config —
  // see core's openOptions), so the resolved runtime is memoized per set, not once.
  // The model registry is heavy and set-independent, so it's shared.
  const runtimeCache = new Map<string, Promise<PiRuntime>>();
  let sharedRegistry: ReturnType<typeof ModelRegistry.create> | undefined;

  const buildRuntime = async (
    allowedSkills: readonly string[] | undefined,
    allowedPlugins: readonly string[] | undefined,
  ): Promise<PiRuntime> => {
    if (options.streamFn !== undefined) {
      return {
        streamFn: options.streamFn,
        basePrompt: resolveBase(undefined),
        harnessTools: resolveTools(undefined),
      };
    }
    if (sharedRegistry === undefined) {
      sharedRegistry = ModelRegistry.create(AuthStorage.create());
      sharedRegistry.refresh();
    }
    const registry = sharedRegistry;
    // createAgentSession (a MAIN export) wires model/auth/providers + the default
    // tool suite from ~/.pi. We reuse its stream function AND its tools so a microfoom
    // turn is a full pi agent that also speaks the FOOM protocol; request.allowedTools
    // narrows the set per turn.
    //
    // Skills + plugins are baked into the prompt + tool set AT SESSION CREATION, so we
    // hand createAgentSession a resource loader filtered to the allowed sets; when
    // neither is constrained we pass none and inherit pi's defaults verbatim.
    const resourceLoader = await buildResourceLoader(allowedSkills, allowedPlugins);
    const available = registry.getAvailable();
    const seed = available[0] ?? registry.getAll()[0];
    const { session } = await createAgentSession({
      modelRegistry: registry,
      ...(seed !== undefined ? { model: seed } : {}),
      ...(resourceLoader !== undefined ? { resourceLoader } : {}),
    });
    return {
      streamFn: session.agent.streamFn,
      registry,
      basePrompt: resolveBase(session.agent.state.systemPrompt),
      harnessTools: resolveTools(session.agent.state.tools),
    };
  };

  const initFor = (
    allowedSkills: readonly string[] | undefined,
    allowedPlugins: readonly string[] | undefined,
  ): Promise<PiRuntime> => {
    const key = runtimeKey(allowedSkills, allowedPlugins);
    let pending = runtimeCache.get(key);
    if (pending === undefined) {
      pending = buildRuntime(allowedSkills, allowedPlugins);
      runtimeCache.set(key, pending);
    }
    return pending;
  };

  return async ({ model: modelId, skills, plugins }) => {
    const runtime = await initFor(skills, plugins);
    const resolveModel =
      options.resolveModel ??
      ((id: string): Model<Api> | undefined => {
        const slash = id.indexOf("/");
        const provider = slash >= 0 ? id.slice(0, slash) : id;
        const name = slash >= 0 ? id.slice(slash + 1) : id;
        return runtime.registry?.find(provider, name);
      });
    const model: Model<Api> | undefined = resolveModel(modelId);
    if (model === undefined) {
      throw new FoomtimeHarnessRejectedError(`unknown model: ${modelId}`);
    }

    // One Agent per session: reusing it across runTurn calls preserves the pi
    // transcript, so a microfoom session() is a continued conversation. Stateless
    // this.agent turns open a fresh session (fresh Agent) each time. A session
    // seeded with prior messages is a fork() branch (see below).
    const makeHarnessSession = (seed?: readonly AgentMessage[]): HarnessSession => {
      let agent: Agent | undefined;
      return {
        // The model receives pi's base prompt with the program prompt appended.
        systemPrompt(programPrompt: string): string {
          return composeSystemPrompt(runtime.basePrompt, programPrompt);
        },
        async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
          const thinkingLevel: ThinkingLevel =
            request.thinking !== undefined && PI_THINKING.has(request.thinking)
              ? (request.thinking as ThinkingLevel)
              : "off";
          // Harness tools narrowed by request.allowedTools (undefined = all, [] =
          // none), then the per-turn FOOM tools (always exposed).
          const allowed = request.allowedTools;
          const harnessTools = (runtime.harnessTools ?? []).filter(
            (tool) => allowed === undefined || allowed.includes(tool.name),
          );
          const tools = [...harnessTools, ...request.tools.map(toAgentTool)];
          const systemPrompt = composeSystemPrompt(runtime.basePrompt, request.systemPrompt);
          if (agent === undefined) {
            agent = new Agent({
              initialState: { systemPrompt, model, thinkingLevel, tools },
              streamFn: runtime.streamFn,
              convertToLlm: (messages: AgentMessage[]) =>
                messages.filter(
                  (message): message is Message =>
                    message.role === "user" ||
                    message.role === "assistant" ||
                    message.role === "toolResult",
                ),
              // Debug escape hatch (parallel to MICROFOOM_LOG): append the EXACT
              // provider request body — system message, messages, tools — as JSONL.
              // The ground truth of what the model receives.
              ...(process.env.MICROFOOM_DUMP_PAYLOAD !== undefined
                ? {
                    onPayload: (payload: unknown) => {
                      appendFileSync(
                        process.env.MICROFOOM_DUMP_PAYLOAD as string,
                        `${JSON.stringify(payload)}\n`,
                      );
                      return undefined;
                    },
                  }
                : {}),
            });
            // Branch seed: continue from a copy of the parent transcript (fork()).
            if (seed !== undefined) agent.state.messages = [...seed];
          } else {
            agent.state.systemPrompt = systemPrompt;
            agent.state.thinkingLevel = thinkingLevel;
            agent.state.tools = tools;
          }

          // Forward pi's live lifecycle events to the run's transcript stream while
          // this turn runs (assistant deltas, tool calls/results). Only subscribe
          // when someone is listening, and always unsubscribe after the turn.
          const onEvent = request.onEvent;
          const unsubscribe =
            onEvent !== undefined
              ? agent.subscribe((event) => {
                  const stream = toStreamEvent(event);
                  if (stream !== undefined) onEvent(stream);
                })
              : undefined;

          const before = agent.state.messages.length;
          try {
            await agent.prompt(request.prompt);
          } finally {
            unsubscribe?.();
          }
          logTurn(logFile, model.id, request, agent.state.messages.slice(before), tools);

          // Usage + text for THIS turn only — the messages appended by this prompt.
          let text = "";
          let usage: UsageDelta = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
          const messages = agent.state.messages;
          for (let index = before; index < messages.length; index += 1) {
            const message = messages[index];
            if (message?.role === "assistant") {
              // pi-agent-core encodes request/model/network failure as a stopReason
              // "error" message (the loop resolves, never throws). Surface it as a
              // harness failure so the run reports it instead of masking it as a
              // missing `foom_return`.
              if (message.stopReason === "error") {
                throw new FoomtimeHarnessUnavailableError(message.errorMessage ?? "model error");
              }
              text = assistantText(message);
              usage = addUsage(usage, message.usage);
            }
          }
          return { assistantText: text, usage };
        },
        // Branch: a new pi session seeded with a COPY of the transcript so far (or
        // the inherited seed when no turn has run yet), diverging independently.
        fork(): HarnessSession {
          const transcript = agent !== undefined ? agent.state.messages : (seed ?? []);
          return makeHarnessSession([...transcript]);
        },
      };
    };
    return makeHarnessSession();
  };
}
