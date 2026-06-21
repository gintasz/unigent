import {
  type AgentSessionEvent,
  type AgentToolResult,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type Theme,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isAbsolute, relative } from "node:path";
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

export interface VibeCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface VibeCallProgress {
  status: "run" | "done" | "fail";
  depth: number;
  startedAt: number;
  endedAt?: number;
  step: string;
  usage?: VibeCallUsage;
}

export interface VibeCallDetails {
  kind: "vibecall";
  program_file_path: string;
  name: string;
  args: string;
  prompt: string;
  status: "running" | "done" | "error" | "aborted";
  depth: number;
  progress?: VibeCallProgress;
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
  depth: number;
  progress: VibeCallProgress;
  onUpdate: ((result: AgentToolResult<VibeCallDetails>) => void) | undefined;
}

export type VibeSubagentRunner = (request: VibeSubagentRunRequest) => Promise<string>;

export interface ThoughtcodeToolOptions {
  runSubagent?: VibeSubagentRunner;
  onVibeReturn?: (value: string) => void;
  depth?: number;
}

const COLLAPSED_ARGS_MAX_LENGTH = 140;
const EXPANDED_ARGS_MAX_LENGTH = 1000;
const COLLAPSED_VALUE_MAX_LENGTH = 200;
const EXPANDED_VALUE_MAX_LENGTH = 2000;
const PATH_MAX_LENGTH = 120;
const STEP_MAX_LENGTH = 180;

function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 6) {
    return truncateEnd(value, maxLength);
  }
  const sideLength = Math.floor((maxLength - 3) / 2);
  const endLength = maxLength - 3 - sideLength;
  return `${value.slice(0, sideLength)}...${value.slice(value.length - endLength)}`;
}

function formatPathForDisplay(path: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(path)) {
    return truncateMiddle(path, PATH_MAX_LENGTH);
  }
  const relativePath = relative(cwd, path);
  const displayPath = relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : path;
  return truncateMiddle(displayPath, PATH_MAX_LENGTH);
}

function formatDuration(startedAt: number, endedAt = Date.now()): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function formatTokens(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 10000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${Math.round(value / 1000)}k`;
}

function formatUsage(usage: VibeCallUsage | undefined): string {
  if (!usage) {
    return "";
  }
  const parts = [`↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`];
  if (usage.cacheRead > 0) {
    parts.push(`R${formatTokens(usage.cacheRead)}`);
  }
  if (usage.cacheWrite > 0) {
    parts.push(`W${formatTokens(usage.cacheWrite)}`);
  }
  if (usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(5)}`);
  }
  return parts.join(" ");
}

function addUsage(progress: VibeCallProgress, usage: unknown): void {
  const record = usage as
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
      }
    | undefined;

  if (!record) {
    return;
  }

  progress.usage ??= {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  progress.usage.input += record.input ?? 0;
  progress.usage.output += record.output ?? 0;
  progress.usage.cacheRead += record.cacheRead ?? 0;
  progress.usage.cacheWrite += record.cacheWrite ?? 0;
  progress.usage.cost += record.cost?.total ?? 0;
}

function previewToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const record = args as Record<string, unknown>;
  if (toolName === "read" && typeof record.path === "string") {
    return record.path;
  }
  if (toolName === "VIBECALL") {
    const name = typeof record.name === "string" ? record.name : "";
    const callArgs = typeof record.args === "string" ? ` ${truncateEnd(record.args, 60)}` : "";
    return `${name}${callArgs}`.trim();
  }
  if (toolName === "VIBERETURN" && typeof record.value === "string") {
    return truncateEnd(record.value, 80);
  }
  for (const key of ["path", "command", "pattern", "query", "url", "value"]) {
    if (typeof record[key] === "string") {
      return truncateEnd(record[key], 80);
    }
  }
  return truncateEnd(JSON.stringify(record), 80);
}

function firstTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const block = part as { type?: string; text?: unknown; thinking?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        return "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function textFromAssistantEvent(event: AgentSessionEvent): string {
  if (event.type !== "message_update") {
    return "";
  }
  const assistantEvent = event.assistantMessageEvent as {
    type?: string;
    content?: unknown;
    delta?: unknown;
    partial?: { content?: unknown };
  };
  if (assistantEvent.type?.startsWith("thinking")) {
    return "";
  }
  if (typeof assistantEvent.content === "string") {
    return assistantEvent.content;
  }
  if (typeof assistantEvent.delta === "string") {
    return assistantEvent.delta;
  }
  return firstTextContent(assistantEvent.partial?.content);
}

function updateProgressFromChildEvent(progress: VibeCallProgress, event: AgentSessionEvent, cwd: string): boolean {
  if (event.type === "agent_start") {
    progress.step = "think";
    return true;
  }
  if (event.type === "message_start" && event.message.role === "assistant") {
    progress.step = "think";
    return true;
  }
  if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent as { type?: string };
    if (assistantEvent.type?.startsWith("thinking")) {
      progress.step = "think";
      return true;
    }
    const text = textFromAssistantEvent(event).replace(/\s+/g, " ").trim();
    if (text) {
      progress.step = `text ${truncateEnd(JSON.stringify(text), STEP_MAX_LENGTH - 5)}`;
      return true;
    }
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    addUsage(progress, event.message.usage);
    if (event.message.stopReason === "error") {
      progress.status = "fail";
      progress.step = `fail ${truncateEnd(event.message.errorMessage ?? "provider error", STEP_MAX_LENGTH - 5)}`;
      return true;
    }
    const text = firstTextContent(event.message.content).replace(/\s+/g, " ").trim();
    if (text) {
      progress.step = `text ${truncateEnd(JSON.stringify(text), STEP_MAX_LENGTH - 5)}`;
      return true;
    }
  }
  if (event.type === "tool_execution_start") {
    const preview = previewToolArgs(event.toolName, event.args);
    const displayPreview = event.toolName === "read" && preview ? formatPathForDisplay(preview, cwd) : preview;
    progress.step = truncateEnd(`tool ${event.toolName}${displayPreview ? ` ${displayPreview}` : ""}`, STEP_MAX_LENGTH);
    return true;
  }
  if (event.type === "tool_execution_end" && event.isError) {
    progress.status = "fail";
    progress.step = `fail ${truncateEnd(event.toolName, STEP_MAX_LENGTH - 5)}`;
    return true;
  }
  if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "VIBERETURN") {
    const value = getTextContent(event.message.content);
    progress.status = "done";
    progress.step = `done ${truncateEnd(value, STEP_MAX_LENGTH - 5)}`;
    return true;
  }
  return false;
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

function createVibeCallProgress(depth: number): VibeCallProgress {
  return {
    status: "run",
    depth,
    startedAt: Date.now(),
    step: "think",
  };
}

function createVibeCallDetails(
  call: VibeCallArgs,
  prompt: string,
  status: VibeCallDetails["status"],
  depth: number,
  progress: VibeCallProgress | undefined,
  extra: Pick<VibeCallDetails, "result" | "error"> = {},
): VibeCallDetails {
  return {
    kind: "vibecall",
    program_file_path: call.program_file_path,
    name: call.name,
    args: call.args,
    prompt,
    status,
    depth,
    ...(progress ? { progress } : {}),
    ...extra,
  };
}

function emitVibeCallProgress(
  request: VibeSubagentRunRequest,
  progress: VibeCallProgress,
  status: VibeCallDetails["status"] = "running",
): void {
  request.onUpdate?.(
    textResult(
      progress.step,
      createVibeCallDetails(request.call, request.prompt, status, request.depth, progress),
    ),
  );
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

function markerForProgress(progress: VibeCallProgress | undefined, status: VibeCallDetails["status"], theme: Theme): string {
  if (progress?.status === "done" || status === "done") {
    return theme.fg("success", "✓");
  }
  if (progress?.status === "fail" || status === "error" || status === "aborted") {
    return theme.fg("error", "✗");
  }
  return theme.fg("accent", "◐");
}

function labelForStatus(progress: VibeCallProgress | undefined, status: VibeCallDetails["status"]): string {
  if (progress?.status === "done" || status === "done") {
    return "done";
  }
  if (progress?.status === "fail" || status === "aborted") {
    return "failed";
  }
  if (status === "error") {
    return "failed";
  }
  return "running";
}

function formatProgressStepForDisplay(step: string, expanded: boolean, cwd: string | undefined): string {
  if (step === "think") {
    return "thinking";
  }
  const textPrefix = "text ";
  if (step.startsWith(textPrefix)) {
    return truncateEnd(`responding ${step.slice(textPrefix.length)}`, expanded ? EXPANDED_VALUE_MAX_LENGTH : STEP_MAX_LENGTH);
  }
  const readPrefix = "tool read ";
  const formatted =
    step.startsWith(readPrefix) && cwd
      ? `${readPrefix}${formatPathForDisplay(step.slice(readPrefix.length), cwd)}`
      : step;
  return truncateEnd(formatted, expanded ? EXPANDED_VALUE_MAX_LENGTH : STEP_MAX_LENGTH);
}

function formatArgsForDisplay(args: string, maxLength: number): string {
  return args.trim() ? truncateEnd(args, maxLength) : "<empty>";
}

function renderVibeCallCall(args: VibeCallParams, theme: Theme, executionStarted: boolean): Text {
  if (executionStarted) {
    return new Text("", 0, 0);
  }
  const name = args.name || "unknown";
  const preview = truncateEnd(args.args || "", 80);
  const suffix = preview ? ` ${theme.fg("dim", preview)}` : "";
  return new Text(`${theme.fg("toolTitle", theme.bold("VIBECALL"))} ${theme.fg("muted", name)}${suffix}`, 0, 0);
}

function renderVibeCallResult(
  result: AgentToolResult<VibeCallDetails>,
  expanded: boolean,
  theme: Theme,
  cwd: string | undefined,
): Text {
  const details = result.details;
  const progress = details.progress;
  const status = labelForStatus(progress, details.status);
  const duration = progress ? formatDuration(progress.startedAt, progress.endedAt) : "";
  const usage = formatUsage(progress?.usage);
  const headerParts = [
    markerForProgress(progress, details.status, theme),
    theme.fg("toolTitle", theme.bold("VIBECALL")),
    theme.fg(status === "done" ? "success" : status === "failed" ? "error" : "accent", status),
    duration,
    `depth=${progress?.depth ?? details.depth}`,
    usage,
  ].filter(Boolean);

  const argsMax = expanded ? EXPANDED_ARGS_MAX_LENGTH : COLLAPSED_ARGS_MAX_LENGTH;
  const valueMax = expanded ? EXPANDED_VALUE_MAX_LENGTH : COLLAPSED_VALUE_MAX_LENGTH;
  const lines = [
    headerParts.join(" "),
    `${theme.fg("muted", "entry")} ${details.name}`,
    `${theme.fg("muted", "file")} ${formatPathForDisplay(details.program_file_path, cwd)}`,
    `${theme.fg("muted", "args")} ${formatArgsForDisplay(details.args, argsMax)}`,
  ];

  if (details.status === "done" && details.result !== undefined) {
    lines.push(`${theme.fg("muted", "done")} ${truncateEnd(details.result, valueMax)}`);
  } else if (details.error) {
    lines.push(`${theme.fg("muted", "fail")} ${truncateEnd(details.error, valueMax)}`);
  } else if (progress?.step) {
    lines.push(formatProgressStepForDisplay(progress.step, expanded, cwd));
  }

  if (expanded) {
    lines.push("", theme.fg("muted", "prompt"));
    for (const line of details.prompt.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  return new Text(lines.join("\n"), 0, 0);
}

export function createVibeCallTool(options: ThoughtcodeToolOptions = {}) {
  const runSubagent = options.runSubagent ?? runThoughtcodeSubagent;
  const depth = options.depth ?? 1;

  return defineTool({
    ...VIBE_CALL_TOOL_DESCRIPTION,
    parameters: vibeCallParameters,
    executionMode: "parallel",
    async execute(
      toolCallId,
      params: VibeCallParams,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<VibeCallDetails>> {
      const call: VibeCallArgs = {
        program_file_path: params.program_file_path,
        name: params.name,
        args: params.args,
      };
      const prompt = buildVibeCallSubagentPrompt(call);
      const progress = createVibeCallProgress(depth);

      try {
        const value = await runSubagent({
          toolCallId,
          call,
          prompt,
          ctx,
          signal,
          depth,
          progress,
          onUpdate,
        });

        progress.status = "done";
        progress.endedAt ??= Date.now();
        progress.step = `done ${truncateEnd(value, STEP_MAX_LENGTH - 5)}`;

        return textResult(value, createVibeCallDetails(call, prompt, "done", depth, progress, { result: value }));
      } catch (error) {
        const status = signal?.aborted ? "aborted" : "error";
        const message = getErrorMessage(error);
        progress.status = "fail";
        progress.endedAt ??= Date.now();
        progress.step = `fail ${truncateEnd(message, STEP_MAX_LENGTH - 5)}`;
        return textResult(
          `VIBECALL ${status}: ${message}`,
          createVibeCallDetails(call, prompt, status, depth, progress, { error: message }),
        );
      }
    },
    renderCall(args, theme, context) {
      return renderVibeCallCall(args, theme, context.executionStarted);
    },
    renderResult(result, { expanded }, theme, context) {
      return renderVibeCallResult(result, expanded, theme, context.cwd);
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
    depth: request.depth + 1,
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
    if (updateProgressFromChildEvent(request.progress, event, cwd)) {
      emitVibeCallProgress(request, request.progress);
    }

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

    emitVibeCallProgress(request, request.progress);
    await session.prompt(request.prompt, {
      expandPromptTemplates: false,
      source: "extension",
    });

    if (returnedValue === undefined) {
      if (subagentError) {
        request.progress.status = "fail";
        request.progress.endedAt = Date.now();
        request.progress.step = `fail ${truncateEnd(subagentError, STEP_MAX_LENGTH - 5)}`;
        emitVibeCallProgress(request, request.progress, "error");
        throw new Error(subagentError);
      }
      request.progress.status = "fail";
      request.progress.endedAt = Date.now();
      request.progress.step = "fail missing VIBERETURN";
      emitVibeCallProgress(request, request.progress, "error");
      throw new Error("Finished without calling VIBERETURN.");
    }

    request.progress.status = "done";
    request.progress.endedAt = Date.now();
    request.progress.step = `done ${truncateEnd(returnedValue, STEP_MAX_LENGTH - 5)}`;
    emitVibeCallProgress(request, request.progress);
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
