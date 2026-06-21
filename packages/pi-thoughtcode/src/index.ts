import {
  type AgentSessionEvent,
  type AgentToolResult,
  type ExtensionCommandContext,
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
import {
  type Component,
  type TUI,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { isAbsolute, relative } from "node:path";
import {
  VIBE_CALL_TOOL_PARAMETERS,
  VIBE_CALL_TOOL_DESCRIPTION,
  VIBE_RETURN_TOOL_PARAMETERS,
  VIBE_RETURN_TOOL_DESCRIPTION,
  buildVibeCallSubagentPrompt,
  type ThoughtcodeToolParameter,
  type VibeCallArgs,
  type VibeReturnArgs,
} from "thoughtcode-core";
import { Type, type Static, type TObject, type TString } from "typebox";

function thoughtcodeParametersToTypeBox<const TParameters extends readonly ThoughtcodeToolParameter[]>(
  parameters: TParameters,
): TObject<{ [TParameterName in TParameters[number]["name"]]: TString }> {
  return Type.Object(
    Object.fromEntries(
      parameters.map((parameter) => [
        parameter.name,
        Type.String({
          description: parameter.description,
        }),
      ]),
    ) as { [TParameterName in TParameters[number]["name"]]: TString },
  );
}

const vibeCallParameters = thoughtcodeParametersToTypeBox(VIBE_CALL_TOOL_PARAMETERS);
const vibeReturnParameters = thoughtcodeParametersToTypeBox(VIBE_RETURN_TOOL_PARAMETERS);

type VibeCallParams = Static<typeof vibeCallParameters>;
type VibeReturnParams = Static<typeof vibeReturnParameters>;

export interface VibeCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export type VibeCallEventType = "thinking" | "tool" | "responding" | "return" | "error" | "status";

export interface VibeCallEvent {
  t: number;
  type: VibeCallEventType;
  text: string;
}

export interface VibeCallTranscriptItem {
  t: number;
  role: "thinking" | "assistant" | "tool" | "return" | "error" | "status";
  text: string;
  toolCallId?: string;
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
  runId: string;
  program_file_path: string;
  name: string;
  args: string;
  prompt: string;
  status: "running" | "done" | "error" | "aborted";
  depth: number;
  progress?: VibeCallProgress;
  events?: VibeCallEvent[];
  transcript?: VibeCallTranscriptItem[];
  result?: string;
  error?: string;
}

export interface VibeReturnDetails {
  kind: "vibereturn";
  value: string;
}

export interface VibeSubagentRunRequest {
  runId: string;
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
const MAX_RUN_EVENTS = 200;
const INSPECT_VIEWPORT_HEIGHT_PCT = 80;

export interface VibeCallRunRecord {
  id: string;
  toolCallId: string;
  call: VibeCallArgs;
  prompt: string;
  status: VibeCallDetails["status"];
  depth: number;
  progress: VibeCallProgress;
  events: VibeCallEvent[];
  transcript: VibeCallTranscriptItem[];
  result?: string;
  error?: string;
  cwd?: string;
  startedAt: number;
  endedAt?: number;
}

const vibeCallRuns = new Map<string, VibeCallRunRecord>();
let vibeCallRunCounter = 0;

function createVibeCallRunId(): string {
  vibeCallRunCounter += 1;
  return `tc-${vibeCallRunCounter}`;
}

export function getVibeCallRun(runId: string): VibeCallRunRecord | undefined {
  return vibeCallRuns.get(runId);
}

export function listVibeCallRuns(): VibeCallRunRecord[] {
  return [...vibeCallRuns.values()];
}

export function clearVibeCallRunsForTests(): void {
  vibeCallRuns.clear();
  vibeCallRunCounter = 0;
}

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

function vibeCallDetailsFromToolResult(result: unknown): VibeCallDetails | undefined {
  const details = (result as { details?: unknown } | undefined)?.details as Partial<VibeCallDetails> | undefined;
  if (details?.kind !== "vibecall" || typeof details.runId !== "string") {
    return undefined;
  }
  return details as VibeCallDetails;
}

function formatNestedVibeCallTool(details: VibeCallDetails): string {
  const args = details.args.trim() ? ` ${truncateEnd(details.args, 80)}` : "";
  return `VIBECALL run=${details.runId} ${details.name}${args}`;
}

function firstTextContent(content: unknown): string {
  return contentBlocksText(content, "text");
}

function thinkingTextContent(content: unknown): string {
  return contentBlocksText(content, "thinking");
}

function contentBlocksText(content: unknown, type: "text" | "thinking"): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const block = part as { type?: string; text?: unknown; thinking?: unknown };
      if (type === "text") {
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      }
      return block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "";
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
  if (assistantEvent.type && !assistantEvent.type.startsWith("text")) {
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

function thinkingFromAssistantEvent(event: AgentSessionEvent): { mode: "delta" | "complete"; text: string } | undefined {
  if (event.type !== "message_update") {
    return undefined;
  }
  const assistantEvent = event.assistantMessageEvent as {
    type?: string;
    content?: unknown;
    delta?: unknown;
  };
  if (assistantEvent.type === "thinking_delta" && typeof assistantEvent.delta === "string") {
    return { mode: "delta", text: assistantEvent.delta };
  }
  if (assistantEvent.type === "thinking_end" && typeof assistantEvent.content === "string") {
    return { mode: "complete", text: assistantEvent.content };
  }
  return undefined;
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
  if (event.type === "tool_execution_update" && event.toolName === "VIBECALL") {
    const details = vibeCallDetailsFromToolResult(event.partialResult);
    if (details) {
      progress.step = truncateEnd(`tool ${formatNestedVibeCallTool(details)}`, STEP_MAX_LENGTH);
      return true;
    }
  }
  if (event.type === "tool_execution_end" && event.toolName === "VIBECALL") {
    const details = vibeCallDetailsFromToolResult(event.result);
    if (details) {
      progress.step = truncateEnd(`tool ${formatNestedVibeCallTool(details)}`, STEP_MAX_LENGTH);
      return true;
    }
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
  runId: string,
  call: VibeCallArgs,
  prompt: string,
  status: VibeCallDetails["status"],
  depth: number,
  progress: VibeCallProgress | undefined,
  events: VibeCallEvent[] | undefined,
  transcript: VibeCallTranscriptItem[] | undefined,
  extra: Pick<VibeCallDetails, "result" | "error"> = {},
): VibeCallDetails {
  return {
    kind: "vibecall",
    runId,
    program_file_path: call.program_file_path,
    name: call.name,
    args: call.args,
    prompt,
    status,
    depth,
    ...(progress ? { progress } : {}),
    ...(events ? { events: [...events] } : {}),
    ...(transcript ? { transcript: [...transcript] } : {}),
    ...extra,
  };
}

function emitVibeCallProgress(
  request: VibeSubagentRunRequest,
  progress: VibeCallProgress,
  status: VibeCallDetails["status"] = "running",
): void {
  const record = vibeCallRuns.get(request.runId);
  request.onUpdate?.(
    textResult(
      progress.step,
      createVibeCallDetails(
        request.runId,
        request.call,
        request.prompt,
        status,
        request.depth,
        progress,
        record?.events,
        record?.transcript,
      ),
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

function classifyProgressStep(step: string): VibeCallEventType {
  if (step === "think") {
    return "thinking";
  }
  if (step.startsWith("tool ")) {
    return "tool";
  }
  if (step.startsWith("text ")) {
    return "responding";
  }
  if (step.startsWith("done ")) {
    return "return";
  }
  if (step.startsWith("fail ")) {
    return "error";
  }
  return "status";
}

function createVibeCallRunRecord(
  runId: string,
  toolCallId: string,
  call: VibeCallArgs,
  prompt: string,
  depth: number,
  progress: VibeCallProgress,
  cwd: string | undefined,
): VibeCallRunRecord {
  return {
    id: runId,
    toolCallId,
    call,
    prompt,
    status: "running",
    depth,
    progress,
    events: [],
    transcript: [],
    cwd,
    startedAt: progress.startedAt,
  };
}

function appendVibeCallEvent(record: VibeCallRunRecord, type: VibeCallEventType, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const last = record.events.at(-1);
  if (last?.type === type && last.text === trimmed) {
    return;
  }
  record.events.push({ t: Date.now(), type, text: trimmed });
  if (record.events.length > MAX_RUN_EVENTS) {
    record.events.splice(0, record.events.length - MAX_RUN_EVENTS);
  }
}

function appendTranscriptItem(
  record: VibeCallRunRecord,
  role: VibeCallTranscriptItem["role"],
  text: string,
  toolCallId?: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  if (toolCallId) {
    const existing = record.transcript.find((item) => item.role === role && item.toolCallId === toolCallId);
    if (existing) {
      existing.text = trimmed;
      existing.t = Date.now();
      return;
    }
  }
  const last = record.transcript.at(-1);
  if (last?.role === role) {
    if (last.text === trimmed || last.text.endsWith(trimmed)) {
      return;
    }
    if (role === "assistant") {
      last.text = `${last.text}${trimmed}`;
      last.t = Date.now();
      return;
    }
  }
  record.transcript.push({ t: Date.now(), role, text: trimmed, ...(toolCallId ? { toolCallId } : {}) });
  if (record.transcript.length > MAX_RUN_EVENTS) {
    record.transcript.splice(0, record.transcript.length - MAX_RUN_EVENTS);
  }
}

function trimTranscript(record: VibeCallRunRecord): void {
  if (record.transcript.length > MAX_RUN_EVENTS) {
    record.transcript.splice(0, record.transcript.length - MAX_RUN_EVENTS);
  }
}

function appendTranscriptDelta(record: VibeCallRunRecord, role: "thinking" | "assistant", delta: string): void {
  if (!delta) {
    return;
  }
  const last = record.transcript.at(-1);
  if (last?.role === role) {
    last.text = `${last.text}${delta}`;
    last.t = Date.now();
    return;
  }
  const text = delta.trimStart();
  if (!text) {
    return;
  }
  record.transcript.push({ t: Date.now(), role, text });
  trimTranscript(record);
}

function appendTranscriptComplete(record: VibeCallRunRecord, role: "thinking" | "assistant", text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  for (let index = record.transcript.length - 1; index >= 0; index -= 1) {
    const item = record.transcript[index];
    if (item.role !== role) {
      continue;
    }
    const existing = item.text.trim();
    if (existing === trimmed || existing.endsWith(trimmed) || trimmed.endsWith(existing)) {
      item.text = trimmed;
      item.t = Date.now();
      return;
    }
  }
  appendTranscriptItem(record, role, trimmed);
}

function appendTranscriptFromAssistantUpdate(record: VibeCallRunRecord, event: AgentSessionEvent): void {
  const thinking = thinkingFromAssistantEvent(event);
  if (thinking) {
    if (thinking.mode === "delta") {
      appendTranscriptDelta(record, "thinking", thinking.text);
    } else {
      appendTranscriptComplete(record, "thinking", thinking.text);
    }
    return;
  }

  const text = textFromAssistantEvent(event);
  if (!text) {
    return;
  }
  const assistantEvent = event.type === "message_update" ? (event.assistantMessageEvent as { type?: string }) : undefined;
  if (assistantEvent?.type === "text_delta") {
    appendTranscriptDelta(record, "assistant", text);
  } else {
    appendTranscriptComplete(record, "assistant", text);
  }
}

function appendTranscriptFromAssistantMessage(record: VibeCallRunRecord, content: unknown): void {
  appendTranscriptComplete(record, "thinking", thinkingTextContent(content));
  appendTranscriptComplete(record, "assistant", firstTextContent(content));
}

function appendNestedVibeCallToolTranscript(record: VibeCallRunRecord, result: unknown, toolCallId: string): boolean {
  const details = vibeCallDetailsFromToolResult(result);
  if (!details) {
    return false;
  }
  appendTranscriptItem(record, "tool", formatNestedVibeCallTool(details), toolCallId);
  return true;
}

function appendProgressEvent(record: VibeCallRunRecord, progress: VibeCallProgress, cwd: string | undefined): void {
  appendVibeCallEvent(
    record,
    classifyProgressStep(progress.step),
    formatProgressStepForDisplay(progress.step, true, cwd),
  );
}

function appendProgressTranscript(
  record: VibeCallRunRecord,
  progress: VibeCallProgress,
  cwd: string | undefined,
  toolCallId?: string,
): void {
  const step = progress.step;
  if (step === "think") {
    return;
  }
  if (step.startsWith("tool ")) {
    appendTranscriptItem(record, "tool", formatProgressStepForDisplay(step, true, cwd).replace(/^tool /, ""), toolCallId);
    return;
  }
  if (step.startsWith("text ")) {
    return;
  }
  if (step.startsWith("done ")) {
    appendTranscriptItem(record, "return", step.slice(5));
    return;
  }
  if (step.startsWith("fail ")) {
    return;
  }
  appendTranscriptItem(record, "status", formatProgressStepForDisplay(step, true, cwd));
}

function appendProgressUpdate(
  record: VibeCallRunRecord,
  progress: VibeCallProgress,
  cwd: string | undefined,
  toolCallId?: string,
): void {
  appendProgressEvent(record, progress, cwd);
  appendProgressTranscript(record, progress, cwd, toolCallId);
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
    `run=${details.runId}`,
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
    if (details.events?.length) {
      lines.push("", theme.fg("muted", "events"));
      for (const event of details.events.slice(-30)) {
        lines.push(`  ${event.type} ${event.text}`);
      }
    }
  }

  return new Text(lines.join("\n"), 0, 0);
}

function padToWidth(value: string, width: number): string {
  const clipped = truncateToWidth(value.replace(/\t/g, "  "), width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export class ThoughtcodeInspectOverlay implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private lastInnerWidth = 80;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly record: VibeCallRunRecord,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {
    if (record.status === "running") {
      this.timer = setInterval(() => this.tui.requestRender(), 500);
      this.timer.unref?.();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.close();
      return;
    }

    const contentLines = this.buildContentLines(this.lastInnerWidth);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (matchesKey(data, "up") || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = false;
    } else if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 12) {
      return [];
    }

    const th = this.theme;
    const innerWidth = Math.max(8, width - 4);
    this.lastInnerWidth = innerWidth;
    const contentLines = this.buildContentLines(innerWidth);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    const row = (content: string) => `${th.fg("border", "│")} ${padToWidth(content, innerWidth)} ${th.fg("border", "│")}`;
    const divider = row(th.fg("dim", "─".repeat(innerWidth)));
    const icon = markerForProgress(this.record.progress, this.record.status, th);
    const status = labelForStatus(this.record.progress, this.record.status);
    const title = `${icon} ${th.bold("Thoughtcode")} ${this.record.id} ${status} ${formatDuration(this.record.startedAt, this.record.endedAt)}`;
    const footerLeft = th.fg("dim", `${contentLines.length} lines`);
    const footerRight = th.fg("dim", "↑↓/jk scroll · PgUp/PgDn · q/Esc close");
    const gap = Math.max(1, innerWidth - visibleWidth(footerLeft) - visibleWidth(footerRight));

    const lines = [
      th.fg("border", `╭${"─".repeat(width - 2)}╮`),
      row(title),
      divider,
      ...Array.from({ length: viewportHeight }, (_, index) => row(visible[index] ?? "")),
      divider,
      row(`${footerLeft}${" ".repeat(gap)}${footerRight}`),
      th.fg("border", `╰${"─".repeat(width - 2)}╯`),
    ];

    return lines;
  }

  invalidate(): void {
    // No cached render state.
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private close(): void {
    if (this.closed) {
      return;
    }
    this.dispose();
    this.done();
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal?.rows ?? 36;
    return Math.max(6, Math.floor((rows * INSPECT_VIEWPORT_HEIGHT_PCT) / 100) - 6);
  }

  private buildContentLines(width: number): string[] {
    const th = this.theme;
    const lines = [
      `${th.fg("muted", "entry")} ${this.record.call.name}`,
      `${th.fg("muted", "file")} ${formatPathForDisplay(this.record.call.program_file_path, this.record.cwd)}`,
      `${th.fg("muted", "args")} ${formatArgsForDisplay(this.record.call.args, EXPANDED_ARGS_MAX_LENGTH)}`,
      `${th.fg("muted", "depth")} ${this.record.depth}`,
      "",
      th.fg("muted", "Prompt"),
    ];

    for (const line of this.record.prompt.split("\n")) {
      lines.push(...wrapTextWithAnsi(`  ${line}`, width));
    }

    lines.push("", th.fg("muted", "Subagent"));
    if (this.record.transcript.length === 0) {
      lines.push(th.fg("dim", "  Waiting for subagent activity..."));
    } else {
      const labels: Record<VibeCallTranscriptItem["role"], string> = {
        assistant: "Assistant",
        tool: "Tool",
        return: "Return",
        error: "Error",
        thinking: "Reasoning",
        status: "Status",
      };
      for (const item of this.record.transcript) {
        lines.push(th.fg("accent", labels[item.role]));
        for (const line of item.text.split("\n")) {
          lines.push(...wrapTextWithAnsi(`  ${line}`, width));
        }
        lines.push("");
      }
      if (lines.at(-1) === "") {
        lines.pop();
      }
    }

    if (this.record.result !== undefined) {
      lines.push("", `${th.fg("muted", "result")} ${truncateEnd(this.record.result, EXPANDED_VALUE_MAX_LENGTH)}`);
    } else if (this.record.error !== undefined) {
      lines.push("", `${th.fg("muted", "error")} ${truncateEnd(this.record.error, EXPANDED_VALUE_MAX_LENGTH)}`);
    }

    return lines;
  }
}

function latestVibeCallRun(): VibeCallRunRecord | undefined {
  return listVibeCallRuns().at(-1);
}

function resolveVibeCallRun(runId: string): VibeCallRunRecord | undefined {
  const trimmed = runId.trim();
  if (!trimmed || trimmed === "latest") {
    return latestVibeCallRun();
  }
  return getVibeCallRun(trimmed);
}

export async function inspectThoughtcodeRun(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const run = resolveVibeCallRun(args);
  if (!run) {
    ctx.ui.notify(args.trim() ? `Thoughtcode run not found: ${args.trim()}` : "No Thoughtcode runs yet.", "warning");
    return;
  }

  if (ctx.mode !== "tui") {
    ctx.ui.notify(`Thoughtcode run ${run.id}: ${run.status}. Use TUI mode for the live inspector.`, "info");
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new ThoughtcodeInspectOverlay(tui, run, theme, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        maxHeight: `${INSPECT_VIEWPORT_HEIGHT_PCT}%`,
        minWidth: 60,
      },
    },
  );
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
      const runId = createVibeCallRunId();
      const run = createVibeCallRunRecord(runId, toolCallId, call, prompt, depth, progress, ctx?.cwd);
      vibeCallRuns.set(runId, run);
      appendProgressUpdate(run, progress, ctx?.cwd);

      try {
        const value = await runSubagent({
          runId,
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
        run.status = "done";
        run.endedAt = progress.endedAt;
        run.result = value;
        appendProgressUpdate(run, progress, ctx?.cwd);

        return textResult(value, createVibeCallDetails(runId, call, prompt, "done", depth, progress, run.events, run.transcript, { result: value }));
      } catch (error) {
        const status = signal?.aborted ? "aborted" : "error";
        const message = getErrorMessage(error);
        progress.status = "fail";
        progress.endedAt ??= Date.now();
        progress.step = `fail ${truncateEnd(message, STEP_MAX_LENGTH - 5)}`;
        run.status = status;
        run.endedAt = progress.endedAt;
        run.error = message;
        appendProgressUpdate(run, progress, ctx?.cwd);
        return textResult(
          `VIBECALL ${status}: ${message}`,
          createVibeCallDetails(runId, call, prompt, status, depth, progress, run.events, run.transcript, { error: message }),
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
  const run = vibeCallRuns.get(request.runId);

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
    if (run && event.type === "message_update") {
      appendTranscriptFromAssistantUpdate(run, event);
    }

    if (updateProgressFromChildEvent(request.progress, event, cwd)) {
      if (run) {
        const toolCallId =
          event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end"
            ? event.toolCallId
            : undefined;
        appendProgressUpdate(run, request.progress, cwd, toolCallId);
      }
      emitVibeCallProgress(request, request.progress);
    }

    if (run && event.type === "tool_execution_update" && event.toolName === "VIBECALL") {
      appendNestedVibeCallToolTranscript(run, event.partialResult, event.toolCallId);
    }
    if (run && event.type === "tool_execution_end" && event.toolName === "VIBECALL") {
      appendNestedVibeCallToolTranscript(run, event.result, event.toolCallId);
    }

    if (event.type !== "message_end") {
      return;
    }
    if (event.message.role === "assistant" && event.message.stopReason === "error") {
      subagentError = event.message.errorMessage ?? "Thoughtcode subagent failed.";
      if (run) {
        appendVibeCallEvent(run, "error", subagentError);
        appendTranscriptItem(run, "error", subagentError);
      }
      return;
    }
    if (event.message.role === "assistant") {
      if (run) {
        appendTranscriptFromAssistantMessage(run, event.message.content);
      }
      return;
    }
    if (event.message.role !== "toolResult") {
      return;
    }
    if (event.message.toolName === "VIBECALL") {
      if (run) {
        appendNestedVibeCallToolTranscript(run, event.message, event.message.toolCallId);
      }
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
        if (run) {
          run.status = "error";
          run.endedAt = request.progress.endedAt;
          run.error = subagentError;
          appendProgressUpdate(run, request.progress, cwd);
        }
        emitVibeCallProgress(request, request.progress, "error");
        throw new Error(subagentError);
      }
      request.progress.status = "fail";
      request.progress.endedAt = Date.now();
      request.progress.step = "fail missing VIBERETURN";
      if (run) {
        run.status = "error";
        run.endedAt = request.progress.endedAt;
        run.error = "Finished without calling VIBERETURN.";
        appendProgressUpdate(run, request.progress, cwd);
      }
      emitVibeCallProgress(request, request.progress, "error");
      throw new Error("Finished without calling VIBERETURN.");
    }

    request.progress.status = "done";
    request.progress.endedAt = Date.now();
    request.progress.step = `done ${truncateEnd(returnedValue, STEP_MAX_LENGTH - 5)}`;
    if (run) {
      run.status = "done";
      run.endedAt = request.progress.endedAt;
      run.result = returnedValue;
      appendProgressUpdate(run, request.progress, cwd);
    }
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
  pi.registerCommand("thoughtcode-inspect", {
    description: "Inspect a live or recent Thoughtcode VIBECALL run. Usage: /thoughtcode-inspect <runId|latest>",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim();
      return listVibeCallRuns()
        .map((run) => run.id)
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ label: id, value: id, description: "Thoughtcode VIBECALL run" }));
    },
    handler: inspectThoughtcodeRun,
  });
};

export default thoughtcodeExtension;
