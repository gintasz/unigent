// The pi harness adapter: the sole binding between core's harness port
// (OpenSession/HarnessSession) and pi's runtime. microfoom programs run as a
// programmatic pi agent: each turn drives a pi-agent-core `Agent` whose loop owns
// the model calls and EXECUTES the FOOM tools (ADR-0002 rev). Core supplies the
// neutral tool semantics + the turn coordinator; this maps them ↔ pi. The
// configured stream function (model + auth + providers from ~/.pi) is obtained
// from pi's own `createAgentSession`. Consumed by the CLI (and any future
// frontend); it carries no extension/TUI concerns of its own.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
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
import { AuthStorage, createAgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  FoomtimeHarnessRejectedError,
  FoomtimeHarnessUnavailableError,
  type HarnessSession,
  type NeutralToolDef,
  type OpenSession,
  type SessionTurnRequest,
  type SessionTurnResult,
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
}

interface PiRuntime {
  readonly streamFn: StreamFn;
  readonly registry?: ModelRegistry;
}

/**
 * Build an OpenSession backed by pi. Resolves models + auth from ~/.pi and obtains
 * pi's configured stream function from `createAgentSession` (done once, lazily).
 * Each microfoom turn drives a pi `Agent` whose loop runs the FOOM tools; a
 * `session()` reuses one Agent (continued transcript), a stateless turn opens a
 * fresh one. Pass the result to runProgram's `openSession`.
 */
export function createPiOpenSession(options: PiSessionOptions = {}): OpenSession {
  const logFile = options.logFile ?? process.env.MICROFOOM_LOG;
  let cached: PiRuntime | undefined;

  const init = async (): Promise<PiRuntime> => {
    if (cached !== undefined) return cached;
    if (options.streamFn !== undefined) {
      cached = { streamFn: options.streamFn };
      return cached;
    }
    const registry = ModelRegistry.create(AuthStorage.create());
    registry.refresh();
    // createAgentSession (a MAIN export) wires model/auth/providers from ~/.pi; we
    // reuse only its configured stream function to drive our own per-turn Agents.
    const available = registry.getAvailable();
    const seed = available[0] ?? registry.getAll()[0];
    const { session } = await createAgentSession({
      modelRegistry: registry,
      noTools: "all",
      ...(seed !== undefined ? { model: seed } : {}),
    });
    cached = { streamFn: session.agent.streamFn, registry };
    return cached;
  };

  return async ({ model: modelId }) => {
    const runtime = await init();
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
    // this.agent turns open a fresh session (fresh Agent) each time.
    let agent: Agent | undefined;

    const session: HarnessSession = {
      async runTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
        const thinkingLevel: ThinkingLevel =
          request.thinking !== undefined && PI_THINKING.has(request.thinking)
            ? (request.thinking as ThinkingLevel)
            : "off";
        const tools = request.tools.map(toAgentTool);
        if (agent === undefined) {
          agent = new Agent({
            initialState: { systemPrompt: request.systemPrompt, model, thinkingLevel, tools },
            streamFn: runtime.streamFn,
            convertToLlm: (messages: AgentMessage[]) =>
              messages.filter(
                (message): message is Message =>
                  message.role === "user" ||
                  message.role === "assistant" ||
                  message.role === "toolResult",
              ),
          });
        } else {
          agent.state.systemPrompt = request.systemPrompt;
          agent.state.thinkingLevel = thinkingLevel;
          agent.state.tools = tools;
        }

        const before = agent.state.messages.length;
        await agent.prompt(request.prompt);
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
            // missing FOOMRETURN.
            if (message.stopReason === "error") {
              throw new FoomtimeHarnessUnavailableError(message.errorMessage ?? "model error");
            }
            text = assistantText(message);
            usage = addUsage(usage, message.usage);
          }
        }
        return { assistantText: text, usage };
      },
    };
    return session;
  };
}
