import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { VIBE_CALL_TOOL_NAME, VIBE_RETURN_TOOL_NAME, VIBE_THROW_TOOL_NAME } from "thoughtcode-core";
import {
  EXPANDED_VALUE_MAX_LENGTH,
  MAX_RUN_EVENTS,
  STEP_MAX_LENGTH,
  formatPathForDisplay,
} from "../shared/display.js";
import { getTextContent } from "../shared/tool-result.js";
import { truncateEnd, truncateStart } from "../shared/truncate.js";
import type { VibeCallProgress, VibeCallRunRecord } from "../types.js";
import {
  appendTranscriptItem,
  formatNestedVibeCallTool,
  vibeCallDetailsFromToolResult,
} from "./transcript.js";

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
  if (toolName === VIBE_CALL_TOOL_NAME) {
    const name = typeof record.name === "string" ? record.name : "";
    const callArgs = typeof record.args === "string" ? ` ${truncateEnd(record.args, 60)}` : "";
    return `${name}${callArgs}`.trim();
  }
  if (toolName === VIBE_RETURN_TOOL_NAME && typeof record.value === "string") {
    return truncateEnd(record.value, 80);
  }
  if (toolName === VIBE_THROW_TOOL_NAME && typeof record.message === "string") {
    // Return the full message; the step is bounded by the caller (EXPANDED_VALUE_MAX_LENGTH at the
    // source, STEP_MAX_LENGTH at compact display time), so the expanded view shows the whole throw.
    return record.message;
  }
  for (const key of ["path", "command", "pattern", "query", "url", "value"]) {
    if (typeof record[key] === "string") {
      return truncateEnd(record[key], 80);
    }
  }
  return truncateEnd(JSON.stringify(record), 80);
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

export function appendTranscriptFromAssistantUpdate(record: VibeCallRunRecord, event: AgentSessionEvent): void {
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

export function appendTranscriptFromAssistantMessage(record: VibeCallRunRecord, content: unknown): void {
  appendTranscriptComplete(record, "thinking", thinkingTextContent(content));
  appendTranscriptComplete(record, "assistant", firstTextContent(content));
}

export function updateProgressFromChildEvent(progress: VibeCallProgress, event: AgentSessionEvent, cwd: string): boolean {
  if (event.type === "agent_start") {
    progress.step = "think";
    return true;
  }
  if (event.type === "message_start" && event.message.role === "assistant") {
    progress.step = "think";
    return true;
  }
  if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent as { type?: string; partial?: { content?: unknown } };
    const partialContent = assistantEvent.partial?.content;
    // Show a trailing window of the ACCUMULATED stream (from `partial`), not the latest tiny delta —
    // a lone "`" delta is useless. truncateStart keeps the tail; display re-trims per compact/expanded.
    if (assistantEvent.type?.startsWith("thinking")) {
      const thinking = thinkingTextContent(partialContent).replace(/\s+/g, " ").trim();
      progress.step = thinking ? `think ${truncateStart(thinking, EXPANDED_VALUE_MAX_LENGTH)}` : "think";
      return true;
    }
    const text = (firstTextContent(partialContent) || textFromAssistantEvent(event)).replace(/\s+/g, " ").trim();
    if (text) {
      progress.step = `text ${truncateStart(text, EXPANDED_VALUE_MAX_LENGTH)}`;
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
      progress.step = `text ${truncateStart(text, EXPANDED_VALUE_MAX_LENGTH)}`;
      return true;
    }
  }
  if (event.type === "tool_execution_start") {
    const preview = previewToolArgs(event.toolName, event.args);
    const displayPreview = event.toolName === "read" && preview ? formatPathForDisplay(preview, cwd) : preview;
    // Keep enough for the expanded transcript; compact display re-truncates to STEP_MAX_LENGTH.
    progress.step = truncateEnd(`tool ${event.toolName}${displayPreview ? ` ${displayPreview}` : ""}`, EXPANDED_VALUE_MAX_LENGTH);
    return true;
  }
  if (event.type === "tool_execution_update" && event.toolName === VIBE_CALL_TOOL_NAME) {
    const details = vibeCallDetailsFromToolResult(event.partialResult);
    if (details) {
      progress.step = truncateEnd(`tool ${formatNestedVibeCallTool(details)}`, STEP_MAX_LENGTH);
      return true;
    }
  }
  if (event.type === "tool_execution_end" && event.toolName === VIBE_CALL_TOOL_NAME) {
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
  if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === VIBE_RETURN_TOOL_NAME) {
    const value = getTextContent(event.message.content);
    progress.status = "done";
    progress.step = `done ${truncateEnd(value, STEP_MAX_LENGTH - 5)}`;
    return true;
  }
  return false;
}
