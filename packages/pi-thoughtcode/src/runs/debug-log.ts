import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { VIBE_RETURN_TOOL_NAME } from "thoughtcode-core";
import { getTextContent } from "../shared/tool-result.js";
import type { VibeCallRunRecord, VibeSubagentRunRequest } from "../types.js";

// Cap individual field sizes so a single huge tool result can't produce an unreadable line.
const MAX_FIELD_CHARS = 20000;

/** Correlation context shared by every log entry of a single VIBECALL run. */
interface RunLogContext {
  traceId: string;
  runId: string;
  parentRunId?: string;
  depth: number;
  cwd: string | undefined;
}

interface DebugLogEntry {
  kind: string;
  [key: string]: unknown;
}

let resolvedEnabled: boolean | undefined;
const traceFilePaths = new Map<string, string>();

/**
 * Logging is on by default and writes to `<cwd>/.thoughtcode/logs/`. Opt out with
 * `THOUGHTCODE_DEBUG=0` (or `false`/`no`/`off`). An explicit `THOUGHTCODE_DEBUG_LOG` file always wins.
 */
function isEnabled(): boolean {
  if (resolvedEnabled === undefined) {
    resolvedEnabled = Boolean(process.env.THOUGHTCODE_DEBUG_LOG) || !isFalsyEnv(process.env.THOUGHTCODE_DEBUG);
  }
  return resolvedEnabled;
}

function isFalsyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

/**
 * Resolve the log file for a trace. An explicit `THOUGHTCODE_DEBUG_LOG` file collects every trace;
 * otherwise each root run gets its own file under `<cwd>/.thoughtcode/logs/`.
 */
function filePathForTrace(context: RunLogContext): string | undefined {
  const explicit = process.env.THOUGHTCODE_DEBUG_LOG;
  if (explicit) {
    return explicit;
  }
  const cached = traceFilePaths.get(context.traceId);
  if (cached) {
    return cached;
  }
  const dir = join(context.cwd ?? process.cwd(), ".thoughtcode", "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${context.traceId}.jsonl`);
  traceFilePaths.set(context.traceId, path);
  return path;
}

function write(context: RunLogContext, entry: DebugLogEntry): void {
  if (!isEnabled()) {
    return;
  }
  const path = filePathForTrace(context);
  if (!path) {
    return;
  }
  const line = {
    ts: formatTimestamp(Date.now()),
    traceId: context.traceId,
    runId: context.runId,
    ...(context.parentRunId ? { parentRunId: context.parentRunId } : {}),
    depth: context.depth,
    ...entry,
  };
  try {
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  } catch {
    // Debug logging must never break a run.
  }
}

/** Local time in ISO 8601 / RFC 3339, e.g. `2026-06-21T19:02:09.655+03:00`. */
function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`
  );
}

function cap(text: string): string {
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…[truncated ${text.length - MAX_FIELD_CHARS} chars]` : text;
}

function contextFromRecord(record: VibeCallRunRecord): RunLogContext {
  return { traceId: record.traceId, runId: record.id, parentRunId: record.parentRunId, depth: record.depth, cwd: record.cwd };
}

function contextFromRequest(request: VibeSubagentRunRequest): RunLogContext {
  return { traceId: request.traceId, runId: request.runId, parentRunId: request.parentRunId, depth: request.depth, cwd: request.ctx.cwd };
}

function textBlocks(content: unknown, type: "text" | "thinking"): string {
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

export function logRunStart(record: VibeCallRunRecord): void {
  write(contextFromRecord(record), {
    kind: "run.start",
    name: record.call.name,
    args: record.call.args,
    file: record.call.program_file_path,
    prompt: cap(record.prompt),
  });
}

export function logRunEnd(record: VibeCallRunRecord, status: string, value: string | undefined): void {
  write(contextFromRecord(record), {
    kind: "run.end",
    status,
    ...(value !== undefined ? { value: cap(value) } : {}),
  });
}

export function logReminder(record: VibeCallRunRecord, text: string): void {
  write(contextFromRecord(record), { kind: "reminder", text });
}

/**
 * Translate a raw child-session event into a milestone log entry. Streaming deltas are ignored;
 * we record completed thinking/text messages, tool calls and their results, returns, and errors.
 */
export function logSessionEvent(request: VibeSubagentRunRequest, event: AgentSessionEvent): void {
  if (!isEnabled()) {
    return;
  }
  const context = contextFromRequest(request);

  if (event.type === "tool_execution_start") {
    write(context, { kind: "tool.start", toolName: event.toolName, toolCallId: event.toolCallId, args: cap(safeJson(event.args)) });
    return;
  }
  if (event.type === "tool_execution_end") {
    write(context, {
      kind: "tool.end",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: Boolean(event.isError),
      result: cap(getTextContent(event.result?.content ?? [])),
    });
    return;
  }
  if (event.type !== "message_end") {
    return;
  }
  if (event.message.role === "assistant") {
    if (event.message.stopReason === "error") {
      write(context, { kind: "agent.error", text: cap(event.message.errorMessage ?? "provider error") });
      return;
    }
    const thinking = textBlocks(event.message.content, "thinking");
    if (thinking) {
      write(context, { kind: "thinking", text: cap(thinking) });
    }
    const text = textBlocks(event.message.content, "text");
    if (text) {
      write(context, { kind: "text", text: cap(text) });
    }
    return;
  }
  if (event.message.role === "toolResult" && event.message.toolName === VIBE_RETURN_TOOL_NAME) {
    write(context, { kind: "return", value: cap(getTextContent(event.message.content ?? [])) });
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
